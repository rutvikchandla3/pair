# 08 Clients and contracts

Status: M0 and M1 landed; the rest is a proposal, rewritten 2026-11-08 for local-first Pair Cloud.
Audience: whoever changes `packages/contracts` or a client for Pair Cloud. Words, decisions and
milestones come from the [plan](./README.md). Code says `sandbox`. The UI says "Cloud" for the
mode and "machine" for a sandbox.

This doc owns the wire. Docs 01 to 07 and 09 say what the servers do. This one says what crosses
the WebSocket, how older clients and servers survive it, and where each client shows it. Where they
disagree, the last section names the conflict and picks a side.

One rule shapes everything below: **clients route, servers never sync.** A member's Pair app is
connected to two environments at once, the local server bundled in the Mac app and the team's Pair
Cloud server. Local work goes to the local server. Cloud goes to Pair Cloud, even when the member
picks it on a local project. Neither server knows about the other until M3's agent link, and that
link runs from the laptop to Pair Cloud only.

## 1. Contract inventory

Every new or changed contract file, the doc that owns its behavior, and its milestone.

| File in `packages/contracts/src`                                                                                                             | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Behavior owner | Milestone      |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------- |
| [environment.ts](../../../packages/contracts/src/environment.ts)                                                                             | `ExecutionEnvironmentCapabilities.cloudLaunch`: the server is cloud-only and its launch gate places every launch (M2). `cloudImport`: it accepts staged seeds and context exports (M3). `ThreadEnvMode` is unchanged                                                                                                                                                                                                                                                                                                                                                                                                          | this doc       | M2, M3         |
| [orchestrationV2.ts](../../../packages/contracts/src/orchestrationV2.ts)                                                                     | Landed: the run preparation split (M0); the cloud member of the launch-input union, thread `sandboxId`, detail `sandbox`, shell `sandbox` summary, client `sandbox.*` commands, internal lifecycle commands, `sandbox.updated` (M1). M2: `delegated_task.request` loses its client-supplied `sandbox` field; optional `existingBranch` on the cloud strategy; `historyOrigin` decodes unknown values. M3, all optional: `seedRef` on the cloud strategy, `contextExportRef` on the launch input, a context export type, a `historyOrigin` value for imported history, "Continued in cloud" and "Continued locally" turn items | 03, 04, 07     | M0, M1, M2, M3 |
| [sandbox.ts](../../../packages/contracts/src/sandbox.ts)                                                                                     | Landed: `SandboxId`, `SandboxState`, `SandboxSize`, `ComputeDriverId`, failure codes, `SandboxAsleep`, the overview and driver check shapes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 04, 07         | M1             |
| [orchestrationProject.ts](../../../packages/contracts/src/orchestrationProject.ts), [project.ts](../../../packages/contracts/src/project.ts) | None. Their `defaultThreadEnvMode` is legacy: the server folds it into project overrides once (`projectSettingsFolded`), and clients read the overrides (section 2)                                                                                                                                                                                                                                                                                                                                                                                                                                                           | this doc       | n/a            |
| [projectClone.ts](../../../packages/contracts/src/projectClone.ts)                                                                           | `ProjectCloneStartInput.destinationPath` becomes optional: a cloud-only server picks the path in its project store. Clients omit it only for a server that reports `cloudLaunch`                                                                                                                                                                                                                                                                                                                                                                                                                                              | 07, 06         | M2             |
| [settings.ts](../../../packages/contracts/src/settings.ts)                                                                                   | Landed: `ServerSettings.sandbox` (driver instances as a tagged union, `defaultDriverId`, `baseImage`, `env`) and project override keys `sandboxAllowed`, `defaultsToCloud`, `sandboxEnv`. M2: no schema change; members get driver config redacted (section 2). M5: the `aws-ec2` member                                                                                                                                                                                                                                                                                                                                      | 04, 06, 09, D6 | M1, M2, M5     |
| [runner.ts](../../../packages/contracts/src/runner.ts) (subpath `./runner`)                                                                  | Runner protocol. Never imported by client bundles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 03             | M1             |
| [package.json](../../../packages/contracts/package.json)                                                                                     | Export `./runner` next to `./settings` and `./relay`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 03             | M1             |
| [clientRpcPermissions.ts](../../../packages/contracts/src/clientRpcPermissions.ts)                                                           | Landed: scopes for new RPCs and the `sandbox.*` dispatch rule. M3: scopes for the move RPCs on the local server                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | this doc       | M1, M3         |
| [scheduledTask.ts](../../../packages/contracts/src/scheduledTask.ts)                                                                         | Nothing for placement: tasks never take `cloud`, and on Pair Cloud the launch gate makes every task run a cloud run. Optional `discardOnSettle`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 01, 04         | M2             |
| [terminal.ts](../../../packages/contracts/src/terminal.ts)                                                                                   | Optional `stoppedBy` on the session snapshot                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 07             | M2             |
| [team.ts](../../../packages/contracts/src/team.ts)                                                                                           | Landed: `TeamMemberGitHub.source` (D1). Later: `TeamUsageResult.sandboxRows` (section 2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 06, 04         | M1, Later      |
| [server.ts](../../../packages/contracts/src/server.ts)                                                                                       | Nothing. `ServerConfig.settings` carries `ServerSettings.sandbox`, and `ServerConfig.memberPush` already gates phone pushes (section 5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | this doc       | n/a            |
| [peerLink.ts](../../../packages/contracts/src/peerLink.ts)                                                                                   | Nothing. The agent link (D14) is an ordinary `PeerLink`, used by local agents and by the moves (section 6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 06, this doc   | M3             |
| `sandboxImage.ts` (new)                                                                                                                      | `TeamImageRecipe`, `TeamImageBuild`, `teamImage.*` RPCs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 05             | M4             |
| [editor.ts](../../../packages/contracts/src/editor.ts)                                                                                       | `RemoteOpenTargetKind` gains `sandbox`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 07             | Later          |
| [managedPolicy.ts](../../../packages/contracts/src/managedPolicy.ts)                                                                         | `limits.cloud` (`cloudOnly`, `allowedDrivers`) in `ManagedPolicyLimits` and the summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 01, 09         | M5             |
| [keybindings.ts](../../../packages/contracts/src/keybindings.ts)                                                                             | `chat.newCloud` command                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 01             | M1             |
| [rpc.ts](../../../packages/contracts/src/rpc.ts)                                                                                             | Landed: `team.githubTokenSet`, `team.githubTokenClear` (D1), `sandbox.overview`, `sandbox.checkDriver`. M3: the local server's move RPCs (seed preview, Continue in cloud, Continue locally). M4: team images                                                                                                                                                                                                                                                                                                                                                                                                                 | 06, 07, 05     | M1, M3, M4     |

Naming resolutions, applied in every row above:

| Concept                        | Code name                                                                | UI name                     | Rejected                                               |
| ------------------------------ | ------------------------------------------------------------------------ | --------------------------- | ------------------------------------------------------ |
| Thread mode                    | launch strategy `{type: "cloud"}`; client-local composer modes           | Cloud                       | `remote`, `hosted`; a new `ThreadEnvMode` literal      |
| Compute unit                   | `sandbox`, `SandboxId`                                                   | machine                     | `environment`, `vm`, `workspace`                       |
| Image the team builds          | `TeamImageBuild` in `sandboxImage.ts`                                    | team image, "build 14"      | `snapshot` (a driver strategy)                         |
| Runner bundle version          | `runnerBuildId`                                                          | not shown                   | bare `buildId`, `runnerBuildHash`                      |
| Image build on a sandbox       | `imageBuildId`                                                           | build 14                    | bare `buildId`                                         |
| Cloud thread                   | a thread with a `sandboxId`                                              | cloud thread, cloud session | a `ThreadEnvMode` value                                |
| Driver instance                | `ComputeDriverId`, several per server, one server-wide default           | the driver's label          | `provider` (taken by agent runtimes)                   |
| Availability gate              | `capabilities.cloudLaunch`, then `ServerSettings.sandbox` lists a driver | none                        | settings alone, which let a desktop server offer Cloud |
| Where a Cloud pick goes        | the Cloud target, from the client-runtime resolver                       | none                        | a server-side link between projects                    |
| Code a local server hands over | `seedRef`                                                                | not shown                   | `bundleId`                                             |

Paths and route names follow the same rule. [apps/server/src/cloud/](../../../apps/server/src/cloud/)
and [apps/mobile/src/features/cloud/](../../../apps/mobile/src/features/cloud/) are T3 Connect. New
code goes in `sandbox` folders, and new UI files say `Sandbox` or `Machine` in their names.

## 2. Compatibility

### Rules

1. **Local stays T3 Code.** A server that is not cloud-only never reports `cloudLaunch`, and with no
   driver it sends no `ServerSettings.sandbox` and no `sandbox` keys on threads. A client connected
   to no environment that reports `cloudLaunch` shows nothing new.
2. **Additive only.** New fields are optional. New literals go only where older readers already
   tolerate unknown values. Nothing persisted or sent to clients is renamed or removed. The one
   removal, `delegated_task.request` leaving the client command union, is an input no client sends
   (below).
3. **Gate by capability, then settings.** A client shows an option only when the server reports its
   capability. `cloudLaunch` says the server's build and mode take cloud launches. Capabilities
   are fixed at startup ([ServerEnvironment.ts](../../../apps/server/src/environment/ServerEnvironment.ts)),
   which is exact here because cloud-only is how a Pair Cloud server starts, not a switch (see
   Conflicts). Settings then say what is configured now. They reach clients in the config snapshot
   and every `settingsUpdated`, redacted, so Cloud appears when an admin adds a driver, with no
   reconnect.
4. **The same rule handles version skew.** The Mac app auto-updates, a team's self-hosted Pair
   Cloud upgrades when its admin does, and phones lag both. A client sends a new input (a cloud
   launch, a `seedRef`, a context export) only to a server that reports the matching capability.
   That matters most for new optional keys: a `Schema.Struct` strips keys it doesn't know, so an
   older Pair Cloud given a `seedRef` would silently launch from GitHub without the seed.
5. **Older clients against a newer Pair Cloud** keep doing what they know. An M1 client reads
   `ServerSettings.sandbox` and offers Cloud on Pair Cloud's projects. It can't route from a local
   project, and it never sees an option gated on a newer capability.

### How unknown values decode today

[baseSchemas.ts](../../../packages/contracts/src/baseSchemas.ts) has the tools.
`ForwardCompatibleOptional`, `ForwardCompatibleNullable` and `OmittedWhenNull` turn an unknown
value into absent or null. `ForwardCompatibleArray` drops elements it can't decode.
`ForwardCompatibleUnion` keeps unknown tagged members as `UnknownUnionMember`. A `Schema.Struct`
strips keys it doesn't know (`onExcessProperty` defaults to `"ignore"`, `.repos/effect` SchemaAST),
so new optional keys are safe to read, though a client that re-sends a whole struct drops them, and
a server that receives one ignores it (rule 4). A new literal in a strict `Schema.Literals` is not
safe.

The thread stream skips unknown event types (`OrchestrationV2UnknownThreadStreamEvent` in
[orchestrationV2.ts](../../../packages/contracts/src/orchestrationV2.ts)), so `sandbox.updated` is
safe. But "A known event type must decode in full": a `run.updated` an old client can't decode
fails the stream.

### Hazards found, and the fix for each

These are why `ThreadEnvMode` keeps its two values and `cloud` lives only in the launch input.

| Wire site                                                                                                     | Today                                                                                                                          | What a `cloud` value would do to an old client                                        | Fix                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OrchestrationProjectShell.defaultThreadEnvMode`                                                              | strict, inside `projects: Schema.Array(...)` of the shell snapshot and in `project.updated` items                              | Fails the whole shell snapshot. No threads load                                       | Never send `cloud` here. The field is legacy (`resolveProjectOverrides` in [projectSettings.ts](../../../packages/shared/src/projectSettings.ts) reads it only before `projectSettingsFolded`), so it gets no sibling |
| `Project`, `ProjectUpdatePayload` in [project.ts](../../../packages/contracts/src/project.ts)                 | strict                                                                                                                         | Fails project reads and updates                                                       | Same: never `cloud`, no new key                                                                                                                                                                                       |
| `ProjectSettingsOverrides.defaultThreadEnvMode` in [settings.ts](../../../packages/contracts/src/settings.ts) | `optionalKey(ThreadEnvMode)`, strict. `keepUnknownOverrideKeys` keeps unknown keys, not unknown values                         | Fails `ServerSettings`, so the server config                                          | Sibling key `defaultsToCloud`. Old clients keep it through `keepUnknownOverrideKeys` when they edit (tested in `settings.test.ts`)                                                                                    |
| `ServerSettings.defaultThreadEnvMode`                                                                         | `OmittedWhenNull`                                                                                                              | Decodes to null: "no default"                                                         | Safe as is                                                                                                                                                                                                            |
| [t3ProjectFile.ts](../../../packages/contracts/src/t3ProjectFile.ts) `defaultThreadEnvMode`                   | strict, in a file committed to the repo                                                                                        | Every older Pair and upstream T3 Code install reading the repo fails on it            | Never offered                                                                                                                                                                                                         |
| `OrchestrationV2Run.workspacePreparation`                                                                     | strict union, inside every run in thread detail and `run.*` events                                                             | Cloud threads fail to open on old clients                                             | Split the union (below)                                                                                                                                                                                               |
| `historyOrigin` on `OrchestrationV2AppThread` and `OrchestrationV2ThreadShell`                                | `Schema.optional(Schema.Literals(["native", "v1_import"]))`, inside `threads: Schema.Array(...)` of the shell snapshot         | A new value for imported history (M3) fails the whole shell snapshot. No threads load | M2 prep: make it `ForwardCompatibleOptional`, so M2 clients read an unknown value as absent. M3 then adds the value                                                                                                   |
| `ScheduledTask.workspaceStrategy`                                                                             | strict union                                                                                                                   | The task fails to decode, or vanishes from `ForwardCompatibleArray` lists             | Never `cloud`: on Pair Cloud the gate places task runs, so old clients list and edit them as ordinary tasks                                                                                                           |
| `TerminalSessionStatus`                                                                                       | strict literals                                                                                                                | A new status fails terminal snapshots                                                 | 07's choice holds: `stoppedBy` is a new optional key, not a status                                                                                                                                                    |
| `RemoteOpenTarget`                                                                                            | `ForwardCompatibleArray` in `ServerConfig.remoteOpenTargets`                                                                   | Dropped                                                                               | Safe                                                                                                                                                                                                                  |
| `ResolvedKeybindingsConfig`                                                                                   | `ForwardCompatibleArray` in [keybindings.ts](../../../packages/contracts/src/keybindings.ts)                                   | `chat.newCloud` dropped                                                               | Safe                                                                                                                                                                                                                  |
| `ManagedPolicyDocument`                                                                                       | rejects excess keys (`onExcessProperty: "error"` in [managedPolicyFile.ts](../../../packages/shared/src/managedPolicyFile.ts)) | An older server refuses a policy file with `limits.cloud`                             | Intended. Policy docs say which release reads it                                                                                                                                                                      |

### Server-only inputs (M2)

Only the server picks a machine's driver and size. The lifecycle commands (`sandbox.provision`,
`sandbox.created`, `sandbox.runner.attached`, `sandbox.runner.lost` and the rest) are already in
`OrchestrationV2InternalCommand`, which `orchestration.dispatchCommand` can't decode. One
client-dispatchable command still carries a server choice: `delegated_task.request.sandbox`
(`{ sandboxId, driverId, size }`, around line 3650 of
[orchestrationV2.ts](../../../packages/contracts/src/orchestrationV2.ts)). The MCP path fills it
after `checkCloudLaunch` in
[OrchestratorMcpService.ts](../../../apps/server/src/mcp/OrchestratorMcpService.ts), but any client
with operate scope can send its own and provision a machine past the gate's project and credential
checks. Only MCP's `delegate_task` on the server sends this command, so M2 moves
`delegated_task.request` into `OrchestrationV2InternalCommand` unchanged
([04](./04-sandbox-lifecycle.md#the-launch-gate-m2)). No client sends it, so none breaks.

### The launch strategy split (M0, M1)

M0 split the run record's union from the launch input, and M1 added `cloud` to the launch input
only. As built:

| Union                                                           | Members                           | Used by                                                                              |
| --------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------ |
| `OrchestrationV2RunWorkspacePreparation`                        | root, existing worktree, worktree | `OrchestrationV2Run.workspacePreparation`, `message.dispatch`'s `defer_start`        |
| `OrchestrationV2ThreadLaunchWorkspaceStrategy` (the same union) | the same three                    | `delegated_task.request`, `ScheduledTask`, `ScheduledTaskUpsertInput`                |
| `OrchestrationV2ThreadLaunchInputWorkspaceStrategy`             | the three plus `cloud`            | `OrchestrationV2ThreadLaunchInput`, MCP `t3_thread_launch` (which `t3 thread` calls) |

```ts
// orchestrationV2.ts
export const OrchestrationV2ThreadLaunchCloudStrategy = Schema.Struct({
  type: Schema.Literal("cloud"),
  baseRef: TrimmedNonEmptyString,
  branch: Schema.optional(TrimmedNonEmptyString),
  // M2 (proposed): `branch` already exists and must be on origin. Without it, `branch` is a new
  // name created from `baseRef`, as M1 mobile sends today.
  existingBranch: Schema.optional(Schema.Literal(true)),
  // M3 (proposed): a staged seed already in the project's mirror.
  seedRef: Schema.optional(StagedSeedId),
});

export const OrchestrationV2ThreadLaunchInputWorkspaceStrategy = Schema.Union([
  ...OrchestrationV2RunWorkspacePreparation.members,
  OrchestrationV2ThreadLaunchCloudStrategy,
]);
```

The launch carries no `size`: the server picks until choosing a size at launch lands (Later). The
union test freezes today's run union, as `auth.test.ts` freezes the old scope vocabulary, and decodes
a cloud launch's run with it.

A cloud run records `{ type: "worktree", baseRef, branch }`, because the checkout in a sandbox is
a worktree of the machine's clone (05). Placement lives on the thread's `sandboxId`, so the retry
path (`ThreadLaunchService.scheduleRunPreparation`, which rebuilds the launch from the run record)
and cloud delegation read it there. `orchestrationV2WorktreePending` stays correct. Old clients see
a worktree thread whose path is `/t3-sandbox/<sandboxId>/...` (02). Their "open in editor" opens
that path on the Pair Cloud server's machine ([remoteOpen.ts](../../../apps/web/src/remoteOpen.ts)),
where it doesn't exist. That is the accepted cost, and it is why section 4 hides local-only actions
on new clients.

### Unpushed branches (M2)

`checkoutInSandbox` in
[CloudPreparation.ts](../../../apps/server/src/sandbox/lifecycle/CloudPreparation.ts) checks out
`origin/<branch>` when it exists and otherwise creates `branch` from `origin/<baseRef>`. That is
right for a new branch, but a launch on a member's local branch that isn't pushed would start from
the base and drop their commits without a word. So a cloud launch from a local project names the
member's branch with `existingBranch: true`, and Pair Cloud refuses one missing on origin with a
new `CloudLaunchError` reason, `branch-not-pushed` ("Push <branch> first"), instead of falling
back. Clients send the key only to a server that reports `cloudLaunch` (rule 4), so no server
strips it. The client also warns before send when the local branch is ahead of its pushed copy:
"N commits not pushed won't be included" (section 4). 07 owns the checkout.

### Moving sessions (M3)

M3 moves a session between a member's Mac and Pair Cloud, in both directions
([07 §8](./07-access-and-data.md#8-moving-sessions-between-a-members-mac-and-pair-cloud-m3)). The
two servers keep separate event stores, so a move makes a new thread on the other side, and the
two link to each other. Everything it adds to the wire is optional, and the Mac app offers a move
only when Pair Cloud reports `cloudImport`:

- **A seed**, for code that isn't on GitHub: a git bundle of the branch against its merge-base with
  `origin/<base>`, plus a snapshot commit of uncommitted and untracked files. The local server
  uploads it over an authenticated HTTP route on Pair Cloud, keyed by the launch's command id so a
  retry replaces it. Pair Cloud stages it, imports it into the project's mirror, and the launch names
  it with `seedRef`. Nothing about the seed rides the WebSocket.
- **A context export** with its own provenance (`environmentId`, `threadId`, `title`), because
  `OrchestrationV2ContextTransfer.sourceThreadId` names a thread in the same event store. It carries
  the thread's messages, size-capped, and goes up through the same route. The launch input names it
  with an optional `contextExportRef`. Pair Cloud imports the messages as read-only history and
  builds the handoff from them in the shape of `prepareLegacyImport`
  ([ContextHandoffService.ts](../../../apps/server/src/orchestration-v2/ContextHandoffService.ts)),
  marking the thread with a new `historyOrigin` value (hazards above).
- **Coming back**, the local server downloads the branch, the snapshot and the export from Pair
  Cloud through the same route and imports them into the local project matched by origin key. The
  owner moves the session; anyone else gets a copy on a new branch, and the cloud session stays
  live.

The local server authenticates every upload and download through the member-scoped agent link
(D14), which the laptop always starts (section 6). Pair Cloud never calls the laptop. A pushed
branch with a clean working tree needs no seed: the move is an M2 launch with `existingBranch`,
plus the export.

Each side records the other as a turn item ("Continued in cloud", "Continued locally") naming the
other thread's `ScopedThreadRef`, which old clients skip.

### Thread, shell and detail fields (M1)

```ts
// sandbox.ts
export const SandboxState = Schema.Literals([
  "provisioning",
  "ready",
  "sleeping",
  "waking",
  "failed",
  "destroyed",
]);

// orchestrationV2.ts
OrchestrationV2AppThread.fields.sandboxId = Schema.optionalKey(SandboxId);

export const OrchestrationV2ThreadShellSandbox = Schema.Struct({
  state: ForwardCompatibleNullable(SandboxState), // a later state shows as "Machine status unknown"
  ownerThreadId: ThreadId, // side chats and forks name the thread whose machine they share
  admission: Schema.optionalKey(
    Schema.Struct({
      reason: ForwardCompatibleNullable(SandboxAdmissionReason),
      since: IsoDateTime,
    }),
  ),
  runnerConnected: Schema.optionalKey(Schema.Boolean), // changes only, debounced 2 s (03)
  failureCode: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
});
OrchestrationV2ThreadShell.fields.sandbox = Schema.optionalKey(OrchestrationV2ThreadShellSandbox);

// thread detail only: the full OrchestrationV2Sandbox from 04, with
// imageBuildId, size, sleepReason, failure.message, lastActiveAt
```

Old clients ignore `sandboxId` and `sandbox`. New clients read state from the shell summary for
rows and headers, and from the detail record for the status panel.

[ProjectionStore.ts](../../../apps/server/src/orchestration-v2/ProjectionStore.ts) builds shells in
`shellFromState` (from `shellThreadStateFromRow`) and `threadShellFromProjection`; both join the
summary. Shell items go out per stored event of one thread, so a `sandbox.*` event on the owner's
stream also re-emits the shells of side chats and forks sharing the sandbox (README decision 6).

### Older clients and servers, surface by surface

| Client and server                                                                  | Sees a cloud thread as        | Can do                                                        | Can't do                                                                          |
| ---------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Desktop or mobile before M0, any server                                            | A worktree thread             | Read, prompt (sending wakes it, 04), review diffs, approve    | Wake, retry, discard; see why it waits                                            |
| An M1 client on Pair Cloud                                                         | A cloud thread                | Everything M1 built, including Cloud on Pair Cloud's projects | Cloud on a local project; anything gated on a newer capability                    |
| An M1 client on a desktop or other non-cloud-only server that still lists a driver | Its old cloud threads         | Read them                                                     | Start one: the server refuses with a message pointing at Pair Cloud               |
| An M2 client on a server that doesn't report `cloudLaunch`                         | Its old cloud threads         | Everything as today                                           | Cloud, which is hidden                                                            |
| The Mac app newer than Pair Cloud                                                  | A cloud thread                | Everything that Pair Cloud reports                            | Options the server doesn't report, such as Continue in cloud before `cloudImport` |
| Pair Cloud's own web origin                                                        | Always the server's own build | Everything                                                    | n/a                                                                               |

Prompting from an old client works because a message to a sleeping sandbox wakes it on the server
(04). A failed sandbox fails the run, which old clients already show.

### Member redaction of driver settings (M2)

`redactServerSettingsForClient` in [serverSettings.ts](../../../apps/server/src/serverSettings.ts)
takes whether the session holds `settings:write`, the scope that can patch `sandbox` (so API tokens
follow it too, not the role name). Without it, each driver is rebuilt from an allowlist: `kind`,
`id`, `label` and `size`, enough for `cloudAvailability` and Overview's read-only rows. With it,
the session gets the rest. Every other key of a driver kind stays optional so the member view
decodes, and M5's `aws-ec2` member follows that rule. Only a writer can patch `sandbox`, so nobody
patches it from the redacted copy.

### Usage (Later)

Usage rows are keyed by member and provider instance, and machine time belongs to no instance, so
it is a separate optional array (04). It lands with editable caps:

```ts
TeamUsageResult.fields.sandboxRows = Schema.optionalKey(
  Schema.Array(
    Schema.Struct({
      memberId: MemberId,
      sandboxSeconds: NonNegativeInt,
      size: SandboxSize,
    }),
  ),
);
```

### A member's own GitHub token (D1, M1)

A cloud thread pushes with the App's installation token, else its owner's GitHub credential, else
not at all. The owner's credential is the existing device-flow link or a token they paste, both on
Pair Cloud: a member's GitHub on their Mac doesn't carry over. The contract follows the existing
`team.githubLink*` and `team.githubDisconnect` methods in
[rpc.ts](../../../packages/contracts/src/rpc.ts):

```ts
// team.ts: old clients ignore the new key
TeamMemberGitHub.fields.source = ForwardCompatibleOptional(Schema.Literals(["app", "token"]));

// rpc.ts: both act only on the caller's own row and return the updated TeamMember
team.githubTokenSet:   { token: TrimmedNonEmptyString } -> TeamMember  // server resolves `login`
team.githubTokenClear: {}                               -> TeamMember
```

The token is a plain string, as `MemberProviderAccountMutation.token` is (`SettingsSecretValue` is
for settings fields and also takes secret-provider references). The link family sits at
`AuthOrchestrationReadScope` in the server's
[RpcAuthorization.ts](../../../apps/server/src/auth/RpcAuthorization.ts), unguarded on clients. The
token pair goes in `CLIENT_GUARDED_RPC_SCOPES` (the server map spreads it) with
`AuthOrchestrationOperateScope`, commented as `teamProviderAccountsMutate` is: ownership, not a
scope, limits which row a member can change. The token is write-only on the wire. A bad token
returns the existing `SourceControlSignInError`. `ServerConfig.teamGitHub` is sent only when the
server has a GitHub client ID, so it gates Connect GitHub, not **Use a token instead**.

Clients derive "can this thread push" from whether the App key setting is set (a redacted secret
field in settings, never the key) and the owner's `TeamMember.github`. A push the server refuses
for lack of a credential fails with code `github-credential-missing`, which clients render as
"Connect GitHub to push".

## 3. Performance on the client wire

| Data                   | How it travels                                                                                                                                                                  | Rule                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Capability flags       | The environment descriptor, once per connection                                                                                                                                 | Booleans. No stream                                                                                                   |
| Cloud target           | Derived in the client from projects and descriptors it already holds                                                                                                            | No request per draft. Recomputed only when projects or connections change                                             |
| Branch check           | The VCS status the composer already subscribes to on the local project                                                                                                          | No extra git call                                                                                                     |
| Shell summary          | `thread.updated` shell items                                                                                                                                                    | A handful of small fields. Only on state change. Never progress ticks                                                 |
| Runner connection      | Shell `runnerConnected`                                                                                                                                                         | Only on change, debounced 2 s (03). A blip under 2 s sends nothing                                                    |
| Full sandbox record    | Thread detail, `sandbox.updated`                                                                                                                                                | Only to subscribers of that thread                                                                                    |
| Provision progress     | `prepared-run.progress`, as worktree setup today: its `phase` sets the title of the run's "Preparing workspace" `command_execution` item, so new phases change no client schema | Steps, not percentages (04)                                                                                           |
| Seeds and exports (M3) | Pair Cloud's HTTP route, local server to Pair Cloud and back, authenticated through the agent link                                                                              | Never the WebSocket. The client sends only the launch                                                                 |
| Setup and build logs   | `teamImage.subscribeBuildLog`, existing setup output                                                                                                                            | Streamed only while the page or panel is open                                                                         |
| Viewer lease (M2)      | One call every 5 minutes per open cloud thread (04)                                                                                                                             | Piggybacks on presence reporting in [presenceReporting.ts](../../../packages/client-runtime/src/presenceReporting.ts) |
| Asleep file reads      | From the mirror (07)                                                                                                                                                            | Same RPCs and paging as today                                                                                         |

UI rules:

- "Starting machine" and "Waking machine" use a static icon and step text. No spinner that repaints
  continuously. Copy changes are the only motion.
- The sidebar row gets one icon and, at most, one short state word. No per-row timers.
- Admission position ("2 ahead of you") is not sent. It would update every waiting row on every
  admit. The count in the shell summary is enough.

## 4. Web and desktop

Desktop wraps the web app. Everything here applies to both unless marked. The Mac app is the main
surface: it is connected to its own local server and to Pair Cloud. The web app at Pair Cloud's own
origin sees Pair Cloud's projects, and the member's local ones only if that browser is also
connected to their local server.

### Where cloud appears

Today each picker asks `cloudAvailability(settings, projectId)` in
[packages/shared/src/sandbox.ts](../../../packages/shared/src/sandbox.ts) about the project's own
environment: the mode picker's `cloudItem` in
[BranchToolbar.tsx](../../../apps/web/src/components/BranchToolbar.tsx), `readCloudAvailable` in
[state/sandbox.ts](../../../apps/web/src/state/sandbox.ts) for `chat.newCloud`,
[CommandPalette.tsx](../../../apps/web/src/components/CommandPalette.tsx) and
[ChatView.tsx](../../../apps/web/src/components/ChatView.tsx). Any server with a driver offers
Cloud, including a desktop server, which
[CloudSettings.tsx](../../../apps/web/src/components/settings/CloudSettings.tsx) only warns about.
From M2 every one of those calls asks the Cloud-target resolver (section 8) instead:

- On a Pair Cloud project, the target is that project, as in M1.
- On a local project, the target is the Pair Cloud project with the same origin repository. The
  member picks Cloud and the launch goes to Pair Cloud.
- A desktop or other non-cloud-only server offers no Cloud of its own. Laptop Docker is dropped, and
  the desktop warning in Settings → Cloud goes with it.

Sidebar grouping by repository already ships (`SidebarProjectGroupingMode`, default
`"repository"`, in [settings.ts](../../../packages/contracts/src/settings.ts), applied by
[projectGrouping.ts](../../../packages/client-runtime/src/state/projectGrouping.ts)), so a cloud
session shows in the same group as the local project it started from. No grouping work.

That grouping cuts the other way too. Auto balance in
[useDraftEnvironmentRouting.ts](../../../apps/web/src/components/chat/useDraftEnvironmentRouting.ts)
and the composer's machine picker choose among a grouped project's environments, so a New worktree
draft could land on Pair Cloud and become a cloud launch there. Both skip environments that report
`cloudLaunch` for every mode except Cloud, and Cloud goes only through the resolver.

| Surface                         | Path                                                                                                                                                                                                   | Change                                                                                                                                                                                                                                                                                                                                                                                         | Milestone     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Mode picker                     | [BranchToolbarEnvModeSelector.tsx](../../../apps/web/src/components/BranchToolbarEnvModeSelector.tsx)                                                                                                  | A **Cloud** item after New worktree when the resolver finds a target. The locked view shows a cloud icon from `sandboxId`, not from `activeWorktreePath`                                                                                                                                                                                                                                       | M1, routed M2 |
| Mode logic                      | [BranchToolbar.logic.ts](../../../apps/web/src/components/BranchToolbar.logic.ts), [BranchToolbar.tsx](../../../apps/web/src/components/BranchToolbar.tsx)                                             | The client-local `EnvMode` has `cloud`, and `resolveEffectiveEnvMode` returns it for a `sandboxId` (M1). `cloudItem` reads the resolver: disabled with its reason when Pair Cloud is offline or the origin isn't on github.com, and **Add to Pair Cloud** when the repo isn't there yet. It never falls back to a local worktree                                                               | M1, M2        |
| Machine picker and auto balance | [useDraftEnvironmentRouting.ts](../../../apps/web/src/components/chat/useDraftEnvironmentRouting.ts), [useLogicalProjectEnvironments.ts](../../../apps/web/src/hooks/useLogicalProjectEnvironments.ts) | Skip environments that report `cloudLaunch` for non-cloud modes                                                                                                                                                                                                                                                                                                                                | M2            |
| Drafts                          | [composerDraftStore.ts](../../../apps/web/src/composerDraftStore.ts)                                                                                                                                   | Draft mode can be `cloud`: its own persisted `DraftThreadEnvModeSchema` and `normalizeDraftThreadEnvMode` have it. A routed draft stays on its local project until it sends. The default stays New worktree; M2 no longer reads `defaultsToCloud` (D4, section 7). Falls back when Cloud becomes unavailable                                                                                   | M1, M2        |
| Send                            | [useComposerSend.ts](../../../apps/web/src/components/chat/useComposerSend.ts), [useHandleNewThread.ts](../../../apps/web/src/hooks/useHandleNewThread.ts)                                             | Map `cloud` to the cloud launch strategy. A routed draft sends the launch to Pair Cloud with its project's id, then opens the new thread there                                                                                                                                                                                                                                                 | M1, routed M2 |
| Launch options                  | The composer's provider and model picker; attachment uploads                                                                                                                                           | In Cloud mode on a local project they read from Pair Cloud: its provider instances and its upload route. The Mac's instance ids don't exist there                                                                                                                                                                                                                                              | M2            |
| Branch                          | The branch picker in [BranchToolbar.tsx](../../../apps/web/src/components/BranchToolbar.tsx)                                                                                                           | A routed launch names the member's current branch with `existingBranch` (section 2), since M2 has no seed. Before send, the local project's VCS status says "Push <branch> first" when it has no upstream (Pair Cloud refuses with `branch-not-pushed` anyway), and warns "N commits not pushed won't be included" when `aheadCount` is above zero. The base drops the remote prefix, as built | M1, M2        |
| Account onboarding              | [ComposerBanner.tsx](../../../apps/web/src/components/chat/ComposerBanner.tsx) slots                                                                                                                   | When Cloud is picked and the member has no usable provider account or GitHub on Pair Cloud, a notice says what to add, linking to their own row in Pair Cloud's Settings → Team, or offers a company account. The Mac's own Claude login can't serve a machine                                                                                                                                 | M2            |
| Header and status               | [ChatHeader.tsx](../../../apps/web/src/components/chat/ChatHeader.tsx), [ThreadStatusLine.tsx](../../../apps/web/src/components/chat/ThreadStatusLine.tsx)                                             | State text and actions from section 7                                                                                                                                                                                                                                                                                                                                                          | M1            |
| Failure and asleep notices      | [ComposerBanner.tsx](../../../apps/web/src/components/chat/ComposerBanner.tsx) slots via [useSystemComposerBanners.tsx](../../../apps/web/src/components/chat/useSystemComposerBanners.tsx)            | Per [Web UI](../../internals/web-ui.md): composer notices use the banner slots                                                                                                                                                                                                                                                                                                                 | M1            |
| Thread details                  | [ThreadDetailsPanel.tsx](../../../apps/web/src/components/chat/ThreadDetailsPanel.tsx)                                                                                                                 | Machine section: driver, size, image build, uptime                                                                                                                                                                                                                                                                                                                                             | M1, image M4  |
| Sidebar                         | [SidebarThreadRow.tsx](../../../apps/web/src/components/sidebar/SidebarThreadRow.tsx)                                                                                                                  | Cloud icon. "Asleep", "Waiting" or "Failed" word                                                                                                                                                                                                                                                                                                                                               | M1            |
| Thread menu                     | [useThreadActionMenu.ts](../../../apps/web/src/hooks/useThreadActionMenu.ts), [chatThreadActions.ts](../../../apps/web/src/lib/chatThreadActions.ts)                                                   | Wake, Sleep now, Retry, Discard machine (M1). Continue in cloud on a local thread, Continue locally on a cloud thread (M3)                                                                                                                                                                                                                                                                     | M1, M3        |
| Command palette                 | [CommandPalette.tsx](../../../apps/web/src/components/CommandPalette.tsx), [CommandPaletteThreadItems.tsx](../../../apps/web/src/components/CommandPaletteThreadItems.tsx)                             | "New cloud thread", routed from a local project in M2, and the thread menu's actions for the active thread                                                                                                                                                                                                                                                                                     | M1, M2, M3    |
| Keybinding                      | [chatRouteCommands.ts](../../../apps/web/src/shortcuts/chatRouteCommands.ts)                                                                                                                           | `chat.newCloud` in `STATIC_KEYBINDING_COMMANDS`, next to `chat.newLocal`. No default binding in [keybindings.ts](../../../packages/shared/src/keybindings.ts). `readCloudAvailable` becomes a resolver read                                                                                                                                                                                    | M1, M2        |
| Terminal                        | [ThreadTerminalDrawer.tsx](../../../apps/web/src/components/ThreadTerminalDrawer.tsx)                                                                                                                  | Stopped machine: terminals show exited (M1). Asleep: read-only with **Wake**; typing wakes, viewing doesn't (M2)                                                                                                                                                                                                                                                                               | M1, M2        |
| Preview                         | [preview/](../../../apps/web/src/components/preview/)                                                                                                                                                  | "Stopped while asleep" with **Restart** (01 J6)                                                                                                                                                                                                                                                                                                                                                | Later         |
| Diffs                           | [DiffPanel.tsx](../../../apps/web/src/components/DiffPanel.tsx)                                                                                                                                        | Unchanged. While stopped, reads fall back to the mirror's latest checkpoint (M1). Snapshot browsing is M2                                                                                                                                                                                                                                                                                      | M1, M2        |
| Worktree setup                  | [useWorktreeSetup.ts](../../../apps/web/src/components/chat/useWorktreeSetup.ts)                                                                                                                       | Skips local worktree prompts when the thread has a `sandboxId`                                                                                                                                                                                                                                                                                                                                 | M1            |
| Open in editor                  | [OpenInPicker.tsx](../../../apps/web/src/components/chat/OpenInPicker.tsx); [remoteOpen.ts](../../../apps/web/src/remoteOpen.ts) resolves per environment, not per thread                              | Local path actions hidden for cloud threads. The `sandbox` target over SSH is Later                                                                                                                                                                                                                                                                                                            | M1, Later     |
| Usage                           | [MemberUsage.tsx](../../../apps/web/src/components/team/MemberUsage.tsx), where team usage shows today ([_chat.usage.tsx](../../../apps/web/src/routes/_chat.usage.tsx) is provider usage limits)      | Machine hours per member from `sandboxRows`                                                                                                                                                                                                                                                                                                                                                    | Later         |
| Projects                        | [ProjectDefaultsSettings.tsx](../../../apps/web/src/components/settings/ProjectDefaultsSettings.tsx)                                                                                                   | "Allow cloud threads" (M1); on Pair Cloud, off turns the project's launches off. Cloud as a project default leaves the UI in M2: nothing reads it (section 7)                                                                                                                                                                                                                                  | M1, M2        |
| Pair Cloud projects             | The Add project flow's clone path on Pair Cloud (`ProjectCloneStartInput`), and **Add to Pair Cloud** from the Cloud item                                                                              | Adds a repo by its GitHub origin. Pair Cloud picks the path, checks the member's access to the repo and clones the checkout and mirror with the App token (07)                                                                                                                                                                                                                                 | M2            |
| Scheduled tasks                 | [ScheduledTasksSettings.tsx](../../../apps/web/src/components/settings/ScheduledTasksSettings.tsx)                                                                                                     | On Pair Cloud the placement reads **Cloud** with a base branch, plus "Discard machine when the run settles"                                                                                                                                                                                                                                                                                    | M2            |
| GitHub App key                  | [SourceControlSettings.tsx](../../../apps/web/src/components/settings/SourceControlSettings.tsx)                                                                                                       | App ID and private key (06), on Pair Cloud                                                                                                                                                                                                                                                                                                                                                     | M1            |
| Member GitHub                   | [MemberGitHub.tsx](../../../apps/web/src/components/team/MemberGitHub.tsx)                                                                                                                             | On the member's own row in Pair Cloud's Settings → Team: **Use a token instead** next to Connect GitHub, **Remove token**, and the warning that agents can read it until the git proxy (Later, D1)                                                                                                                                                                                             | M1            |
| Push notice                     | ComposerBanner slots                                                                                                                                                                                   | "Connect GitHub to push", linking the owner to their row; others see "Ask <owner> to connect GitHub"                                                                                                                                                                                                                                                                                           | M1            |

### Settings → Cloud

`/settings/cloud` sits in `SETTINGS_NAV_GROUPS` of
[settingsSearch.ts](../../../apps/web/src/components/settings/settingsSearch.ts), rendered by
[SettingsSidebarNav.tsx](../../../apps/web/src/components/settings/SettingsSidebarNav.tsx). Settings
are scoped to one environment (`useSettingsScope`), and from M2 this page belongs to Pair Cloud: it
shows for an environment that reports `cloudLaunch`. Anywhere else it shows only while that server
still lists a driver, read-only apart from removing the driver, with a notice that Cloud moved to
Pair Cloud. An M1 team server's admin or a desktop user can see and clear what's left. Each
sub-page is a section on one route, as other settings pages are, so search can reach them.

| Section               | Holds                                                                                                                                                                                                                                        | Who edits                        | Milestone |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | --------- |
| Overview              | Driver health, running machines, base image in use, mirror size, the Docker isolation warning (07, 01). No desktop-server warning: no desktop server offers Cloud                                                                            | Admins; members read             | M1, M2    |
| Compute               | Driver instances, machine size and the `sandbox.baseImage` override (M1, D6); read-only caps: team cap and starts per minute, no member cap (D5); idle period and retention from 04 (M2). Editable caps and an optional member cap are Later | Admins                           | M1, M2    |
| Environment variables | Team layer, reserved names (06). A member layer is Later                                                                                                                                                                                     | Admins                           | M1        |
| Team image            | Recipe, builds, history, activate (05)                                                                                                                                                                                                       | Admins                           | M4        |
| Usage                 | Machine hours per member                                                                                                                                                                                                                     | Admins                           | Later     |
| Access                | SSH keys and "Allow SSH into machines" (07)                                                                                                                                                                                                  | Each member; the switch is admin | Later     |
| Policy                | Read-only rows from managed policy (`limits.cloud`)                                                                                                                                                                                          | Admins                           | M5        |

Settings → Access already exists ([_chat.settings.access.tsx](../../../apps/web/src/routes/_chat.settings.access.tsx)).
The SSH section is titled "Machine access" so search doesn't mix the two. Project env vars sit in
the project's settings on Pair Cloud (06). The Mac app adds Pair Cloud as an environment in
Settings → Connections ([_chat.settings.connections.tsx](../../../apps/web/src/routes/_chat.settings.connections.tsx)),
unchanged.

### Every entry point per action

| Action                   | Composer                                           | Thread menu                    | Command palette     | Keybinding      | Header or banner                  | Settings                                                  | MCP and CLI                                                                                                       | Milestone              |
| ------------------------ | -------------------------------------------------- | ------------------------------ | ------------------- | --------------- | --------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Start in cloud           | Mode picker **Cloud**, routed from a local project | n/a                            | "New cloud thread"  | `chat.newCloud` | n/a                               | n/a                                                       | On Pair Cloud: `t3_thread_launch`, `delegate_task`, `t3 thread start --cloud`. From a laptop: the agent link (M3) | M1, routed M2          |
| Add a repo to Pair Cloud | **Add to Pair Cloud** on the Cloud item            | n/a                            | n/a                 | none            | n/a                               | Pair Cloud's Add project                                  | `t3_project_clone` on Pair Cloud                                                                                  | M2                     |
| Wake machine             | Sending wakes                                      | **Wake**                       | "Wake machine"      | none            | **Wake** in the asleep notice     | n/a                                                       | Any thread tool that needs the machine (04)                                                                       | M1 manual, M2 triggers |
| Sleep now                | n/a                                                | **Sleep now**                  | "Sleep machine"     | none            | n/a                               | Idle period                                               | none                                                                                                              | M1                     |
| Retry                    | n/a                                                | **Retry**                      | "Retry machine"     | none            | **Retry** in the failure notice   | n/a                                                       | none                                                                                                              | M1                     |
| Discard machine          | n/a                                                | **Discard machine**            | "Discard machine"   | none            | **Discard** in the failure notice | Retention                                                 | none                                                                                                              | M1                     |
| Send to cloud            | n/a                                                | **Continue in cloud**          | "Continue in cloud" | none            | n/a                               | n/a                                                       | The same local-server method, for laptop agents (open question 1)                                                 | M3                     |
| Bring it back            | n/a                                                | **Continue locally** (desktop) | "Continue locally"  | none            | n/a                               | n/a                                                       | none                                                                                                              | M3                     |
| Connect GitHub to push   | n/a                                                | n/a                            | n/a                 | none            | Push notice links to the row      | Team → own row: Connect GitHub or **Use a token instead** | none                                                                                                              | M1                     |
| Remove own token         | n/a                                                | n/a                            | n/a                 | none            | n/a                               | Team → own row: **Remove token**                          | none                                                                                                              | M1                     |

Each action is a `createEnvironmentRpcCommand` in client-runtime (section 8). Web, desktop and
mobile call the same command. The menu, palette and banner read the same permission atom, so they
agree on what is offered. A routed action runs against the environment the resolver names, never
the one the draft sits on.

### Moving a session (M3)

Both moves are service methods on the Mac's local server, which does the git work and talks to
Pair Cloud through its agent link (D14, section 6). The client calls the local server and then
opens the thread on the other side. The desktop client is already connected to its local server,
so this needs no new IPC, and the two ship in one build, so the local side needs no capability.

- **Continue in cloud.** On a local thread whose project matches a Pair Cloud project by origin
  key, when Pair Cloud reports `cloudImport`. The client first checks that the member has a usable
  provider account and GitHub on Pair Cloud, as an M2 launch does. The local server previews what
  would go (commits ahead of `origin/<base>`, changed and untracked files that aren't ignored) and
  lets the member exclude files. On confirm it uploads the seed and the export and launches on Pair
  Cloud as the member. The local thread gets a "Continued in cloud" row linking to the new thread,
  and its worktree and branch stay.
- **Continue locally (desktop).** On a cloud thread. The local server downloads the branch, the
  snapshot and the export from Pair Cloud and starts a local thread in the project matched by
  origin key. An asleep machine isn't woken: the snapshot taken before sleep serves. When the owner
  does this, the cloud session settles and its machine sleeps. Anyone else gets a copy on a new
  branch, and the cloud session stays live for the team.

Both are blocked while a run is active, and the menu says why. Nothing goes through GitHub, so both
work for branches that were never pushed. What moves and what doesn't is 07's list: commits pushed
or not, uncommitted and untracked files, and the conversation move; ignored files, earlier
checkpoints, terminals, running processes and native provider sessions don't.

### Desktop only

- **Desktop is never Pair Cloud (M2).** A desktop server doesn't report `cloudLaunch`, so it offers
  no Cloud of its own. Cloud threads it already holds stay readable; new cloud launches are refused
  with a message pointing at Pair Cloud.
- **Open in editor (Later).** `t3 ssh setup` writes the SSH config (07). Desktop opens the
  `vscode-remote` URL built in [editor.ts](../../../packages/contracts/src/editor.ts).
  [DesktopSshEnvironment.ts](../../../apps/desktop/src/ssh/DesktopSshEnvironment.ts) connects to
  remote T3 servers and is unrelated. Don't reuse its name.

## 5. Mobile

Navigation follows [Mobile navigation](../../internals/mobile-navigation.md): opening a cloud thread
is a select, through
[workspace-detail-selection.ts](../../../apps/mobile/src/features/workspace/workspace-detail-selection.ts).
Settings pages share one native screen.

The phone keeps both connections. Its connection to a member's Mac (LAN, Tailscale or T3 Connect
remote access) stays exactly as today, so the member still drives local work from the phone. The
phone also pairs with Pair Cloud through the normal add-environment flow
([ConnectionsNewRouteScreen.tsx](../../../apps/mobile/src/features/connection/ConnectionsNewRouteScreen.tsx)),
over HTTPS on the team's domain. Anyone on the team can start a cloud session from the phone in M2:
on a Pair Cloud project directly, or on a Mac project, where the shared resolver routes the launch
to the matching Pair Cloud project. The phone shows Cloud only when a paired environment reports
`cloudLaunch`. Servers never sync, so nothing tells a phone paired only with the Mac that the team
has a Pair Cloud, and it shows nothing new. Routing a launch through the Mac's local server waits
for M3's agent link.

| Screen or flow     | Path                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Change                                                                                                                                                                                                                                                                  | Milestone |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| New task mode      | [NewTaskContextPickerScreens.tsx](../../../apps/mobile/src/features/threads/NewTaskContextPickerScreens.tsx); `WorkspaceMode` in [new-task-flow-provider.tsx](../../../apps/mobile/src/features/threads/new-task-flow-provider.tsx) and [new-task-context-presentation.ts](../../../apps/mobile/src/features/threads/new-task-context-presentation.ts); [use-new-task-project-defaults.ts](../../../apps/mobile/src/features/threads/use-new-task-project-defaults.ts) | The client-local mode has `cloud` and a base branch picker (M1). The **Cloud** row reads the resolver instead of `cloudAvailability` on the project's own settings: on a Mac project it routes to Pair Cloud, with Pair Cloud's provider instances and the branch check | M1, M2    |
| Machine picker     | [DraftEnvironmentControl.tsx](../../../apps/mobile/src/features/threads/DraftEnvironmentControl.tsx)                                                                                                                                                                                                                                                                                                                                                                   | Skips environments that report `cloudLaunch` for non-cloud modes, as on web                                                                                                                                                                                             | M2        |
| Account onboarding | [NewTaskDraftScreen.tsx](../../../apps/mobile/src/features/threads/NewTaskDraftScreen.tsx)                                                                                                                                                                                                                                                                                                                                                                             | The same notice as web, opening the Team screen on Pair Cloud                                                                                                                                                                                                           | M2        |
| Thread header      | [ThreadHeader.tsx](../../../apps/mobile/src/features/threads/ThreadHeader.tsx)                                                                                                                                                                                                                                                                                                                                                                                         | State text, as on web                                                                                                                                                                                                                                                   | M1        |
| Thread actions     | [ThreadSettingsSheet.tsx](../../../apps/mobile/src/features/threads/ThreadSettingsSheet.tsx)                                                                                                                                                                                                                                                                                                                                                                           | Wake, Retry, Sleep now, Discard machine (M1). Continue in cloud on a Mac thread (M3, open question 4)                                                                                                                                                                   | M1, M3    |
| Thread list        | [thread-list-v2-items.tsx](../../../apps/mobile/src/features/threads/thread-list-v2-items.tsx)                                                                                                                                                                                                                                                                                                                                                                         | Cloud icon and state word                                                                                                                                                                                                                                               | M1        |
| Work log           | [thread-work-log.tsx](../../../apps/mobile/src/features/threads/thread-work-log.tsx)                                                                                                                                                                                                                                                                                                                                                                                   | Provision steps from `prepared-run.progress`                                                                                                                                                                                                                            | M1        |
| Terminal           | [ThreadTerminalRouteScreen.tsx](../../../apps/mobile/src/features/terminal/ThreadTerminalRouteScreen.tsx)                                                                                                                                                                                                                                                                                                                                                              | Exited while stopped (M1). Read-only asleep state with **Wake** (M2)                                                                                                                                                                                                    | M1, M2    |
| Scheduled tasks    | [SettingsScheduledTasksRouteScreen.tsx](../../../apps/mobile/src/features/settings/SettingsScheduledTasksRouteScreen.tsx), [scheduledTaskDraft.ts](../../../apps/mobile/src/features/settings/scheduledTaskDraft.ts)                                                                                                                                                                                                                                                   | On Pair Cloud, Cloud as the placement                                                                                                                                                                                                                                   | M2        |
| Usage              | [UsageRouteScreen.tsx](../../../apps/mobile/src/features/usage/UsageRouteScreen.tsx)                                                                                                                                                                                                                                                                                                                                                                                   | Machine hours. It shows provider usage only today; mobile has no team usage yet                                                                                                                                                                                         | Later     |
| Cloud status page  | [SettingsMachinesRouteScreen.tsx](../../../apps/mobile/src/features/settings/SettingsMachinesRouteScreen.tsx)                                                                                                                                                                                                                                                                                                                                                          | Read-only: driver health, running machines (M1); the active image build (M4). For Pair Cloud                                                                                                                                                                            | M1, M4    |
| Member GitHub      | [SettingsTeamRouteScreen.tsx](../../../apps/mobile/src/features/settings/SettingsTeamRouteScreen.tsx), [TeamMemberGitHub.tsx](../../../apps/mobile/src/features/settings/TeamMemberGitHub.tsx)                                                                                                                                                                                                                                                                         | Own row: GitHub source, **Use a token instead** (secure paste field), **Remove token**                                                                                                                                                                                  | M1        |
| Push notice        | [ThreadDetailScreen.tsx](../../../apps/mobile/src/features/threads/ThreadDetailScreen.tsx)                                                                                                                                                                                                                                                                                                                                                                             | "Connect GitHub to push", opening the Team screen                                                                                                                                                                                                                       | M1        |
| Open in editor     | Thread sheet                                                                                                                                                                                                                                                                                                                                                                                                                                                           | "Open on a computer" explains SSH (07)                                                                                                                                                                                                                                  | Later     |

The new mobile code goes under `features/threads` and `features/settings`, never
`features/cloud`, which is T3 Connect.

Mobile leaves out, by design:

- Driver, caps, env var and policy editing. These are admin tasks with secrets.
- Team image recipe editing and build logs. Mobile shows the active build and pushes.
- SSH keys and open in editor.
- Continue locally to "this device". A phone has no local server.

### Pushes

Pair publishes one app build, with Pair's own store ids and EAS project, and any Pair Cloud server
can notify it (M2). The send path is today's: a server in team mode sets `ServerConfig.memberPush`
([server.ts](../../../packages/contracts/src/server.ts)); the phone registers the build's Expo push
token with every such environment through `push.register`
([memberPushRegistration.ts](../../../apps/mobile/src/features/agent-awareness/memberPushRegistration.ts));
and the server posts to Expo's push API with no Expo access token
([MemberPushNotifier.ts](../../../apps/server/src/notifications/MemberPushNotifier.ts)). Expo
delivers only to the EAS project that issued a token, and every Pair phone's token comes from
Pair's project, so a self-hosted Pair Cloud reaches it with no per-team build and no Pair-hosted
relay. That needs Pair's EAS project to keep its push access-token requirement off, and Pair Cloud
to reach `exp.host` outbound (09). A cloud-only server also sends member pushes from its first
member, where today a server with one active member sends none. When that PR ships, the team-build
guidance in [decisions.md](../decisions.md) ("Identifiers and builds") and
[Team push notifications](../../operations/team-push.md) changes with it. Live Activities ride the
T3 Connect relay ([CloudLink.ts](../../../apps/server/src/cloud/CloudLink.ts)), which Pair Cloud
doesn't use, so cloud sessions notify by push.

"Machine failed" is `machine-failed` in `ThreadNotificationKind`
([threadNotificationRouting.ts](../../../packages/shared/src/threadNotificationRouting.ts)), routed
like `failed` (M1). Build pushes (M4) get their own routing function there, because they have no
thread. They go to the admin who started the build, or to the admins who prompted the image thread
(01).

## 6. Agents and automation

### MCP launch tools (M1)

Agents reach cloud through the same tools users' agents use today. On Pair Cloud every launch is a
cloud launch: the launch gate places it whatever strategy or isolation it names, so an agent there
needs no flag.

| Tool                        | File                                                                                                                                                                                                 | Change                                                                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t3_thread_launch`          | [project/tools.ts](../../../apps/server/src/mcp/toolkits/project/tools.ts)                                                                                                                           | `workspaceStrategy` takes `{type:"cloud", baseRef}`; the description gains one clause (landed). From a laptop, `environmentId` names Pair Cloud through the agent link (M3) |
| `delegate_task`             | [orchestrator/tools.ts](../../../apps/server/src/mcp/toolkits/orchestrator/tools.ts), `OrchestratorMcpDelegateTaskInput` in [orchestratorMcp.ts](../../../packages/contracts/src/orchestratorMcp.ts) | `isolation` has `"cloud"` beside `shared` and `worktree` (landed). Its placement leaves the client wire in M2 (section 2)                                                   |
| `create_threads`            | same                                                                                                                                                                                                 | No new field. Its threads inherit the caller's checkout; on Pair Cloud the gate places them (06). Cloud fan-out uses `delegate_task` or `t3_thread_launch`                  |
| `orchestrator_capabilities` | same                                                                                                                                                                                                 | Reports `features.cloudThreads`, so an agent asks before it launches (landed)                                                                                               |
| `t3_thread_read`            | same                                                                                                                                                                                                 | Returns the shell `sandbox` summary                                                                                                                                         |
| Continue in cloud           | [thread/tools.ts](../../../apps/server/src/mcp/toolkits/thread/tools.ts) on the laptop                                                                                                               | Laptop agents reach the local server's move method (M3). Which tool carries it is open question 1                                                                           |
| `t3_team_image_*`           | `apps/server/src/mcp/toolkits/sandboxImage/` (new)                                                                                                                                                   | 05's six tools (M4)                                                                                                                                                         |

These descriptions are model-facing text. Changing them means running the evals named in
[evals/README.md](../../../evals/README.md), with a case where a model must pick cloud for "run
this where my laptop can sleep" (M1), and in M3 one where a laptop agent must send that work to
Pair Cloud's environment.

Permission checks, all on the server:

- Launch: `McpToolAccess` in [McpToolAccess.ts](../../../apps/server/src/mcp/McpToolAccess.ts)
  already checks the caller and its mode ceiling. The launch gate adds: the project allows cloud,
  the team is under its cap and start rate (no member cap by default, D5), and, from M5, managed
  policy allows the driver. At a cap, launch succeeds and the child waits (01 J7).
- Wake, sleep, retry, discard: no MCP tool. Thread tools that need the machine wake it (04).
  Discard stays a human decision.
- Team image tools: admin only, as `AuthSettingsWriteScope` guards their RPCs.

### `t3 thread` (M1)

[cli/thread.ts](../../../apps/server/src/cli/thread.ts) calls `t3_thread_launch` with a
`workspaceStrategy` built from `--worktree` and `--branch`, plus one flag (landed):

```text
t3 thread start api "fix flaky test" --cloud main [--branch fix/flaky]
```

`--cloud <ref>` mirrors `--worktree <ref>`. The two are mutually exclusive. `--wait` works
unchanged. A waiting machine prints "Waiting for a machine" to stderr once. `t3 thread show`
prints the machine state line. Pointed at Pair Cloud (its URL and an API token), `--cloud` is
optional: the gate makes every launch there a cloud launch.

### Scheduled tasks and webhooks (M2)

On Pair Cloud every launch is cloud, so scheduled tasks and webhooks launch cloud sessions with no
new placement field. A task keeps its `OrchestrationV2ThreadLaunchWorkspaceStrategy`, which never
carries `cloud`, and the gate places each run on its own machine, as it places a cloud
`delegate_task` child. `discardOnSettle` is a new optional key on the task. Run history shows
"Waiting for a machine" from the run's admission state. Old clients list and edit these tasks as
ordinary ones; one that re-saves a task drops `discardOnSettle`, and the machine then follows the
idle policy. That loss is accepted.

### The agent link (M3)

M3 adds one member-scoped link from the laptop's local server to Pair Cloud, in that direction
only. It is a peer link ([peerLink.ts](../../../packages/contracts/src/peerLink.ts)) like any other,
so nothing new crosses the wire. An agent on the laptop launches with `t3_thread_launch` and
`environmentId`, or delegates with `delegate_task` and `target.environmentId`, which
[RemoteDelegation.ts](../../../apps/server/src/peer/RemoteDelegation.ts) turns into a
`t3_thread_launch` on Pair Cloud with `delegatedFrom` set. Both go out through
[PeerForwarding.ts](../../../apps/server/src/peer/PeerForwarding.ts). `t3 thread` on the laptop
uses the same path. The moves use the link too: the local server authenticates its seed and export
uploads and downloads with it, as the member (section 2). Rules:

- Member-scoped: proposed, Pair Cloud binds the link to the member who minted its pairing code, so
  launches and moves through it are that member's, on their accounts and under the team cap (06).
  It is not an admin link or a server identity.
- Laptop to cloud only, and always started by the laptop. Pair Cloud never holds a link to a
  laptop, so nothing on Pair Cloud can start work on a member's machine, and Continue locally is a
  download the laptop starts. On a cloud-only server `t3_environment_link` is admin only (06).
- RemoteDelegation refuses `isolation: "worktree"` and `"cloud"` today and points at
  `t3_thread_launch`. For a target that reports `cloudLaunch` it accepts `"cloud"`, and the target
  places the task with its own drivers, caps and policy.
- An agent checks `orchestrator_capabilities` for the target before sending `cloud`. A target that
  doesn't report `cloudLaunch` refuses with the existing typed failure, never a silent fallback to
  a worktree.
- The base must be on GitHub, as in M2, unless the launch names a seed (open question 6).
- The caller's cap does not apply on the target. The target's member mapping does.

Other peer links are unchanged.

## 7. Reverse states on every surface

Every way in has a way out and a way to see it.

| Way in                                                 | Way out                                                                                            | Where you see it                                                                                                                           | Web, desktop | Mobile             | MCP, CLI                                  |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ------------------ | ----------------------------------------- |
| Pair Cloud connected (M2)                              | Remove the connection. Local work is untouched; cloud threads stay on Pair Cloud                   | Settings → Connections                                                                                                                     | yes          | yes                | n/a                                       |
| Repo added to Pair Cloud (M2)                          | Remove the project on Pair Cloud. The local project is untouched                                   | Pair Cloud's project list                                                                                                                  | yes          | yes                | `t3_project_clone` in                     |
| Start in cloud                                         | Discard machine, or Continue locally (M3)                                                          | Cloud icon, header state                                                                                                                   | yes          | yes                | Launch only                               |
| Sleep (idle in M2, manual, or once all threads settle) | Wake, send, open thread                                                                            | "Asleep"                                                                                                                                   | yes          | yes                | Thread tools wake                         |
| Failed                                                 | Retry, or Discard                                                                                  | Failure notice with reason                                                                                                                 | yes          | yes                | `t3_thread_read` shows it                 |
| Waiting at a cap                                       | Admission, or Discard a machine                                                                    | "Waiting for a machine"                                                                                                                    | yes          | yes                | Launch result and read                    |
| Discarded                                              | **Start a new machine** focuses the composer; sending provisions                                   | "Machine discarded"                                                                                                                        | yes          | yes                | Launch or send                            |
| Project defaults to Cloud (M1 key)                     | Clear `defaultsToCloud`. M2 offers no way in, since nothing reads it                               | Settings → Projects, while set                                                                                                             | yes          | read-only          | n/a                                       |
| Own GitHub token set (D1)                              | **Remove token**; the thread then shows "Connect GitHub to push"                                   | Own row in Settings → Team                                                                                                                 | yes          | yes                | n/a                                       |
| "Connect GitHub to push"                               | Connect GitHub, or **Use a token instead**                                                         | Push notice on the thread                                                                                                                  | yes          | yes                | Push error `github-credential-missing`    |
| Base image override                                    | Clear `sandbox.baseImage`; the version-matched image returns                                       | Settings → Cloud → Compute                                                                                                                 | yes          | read-only          | n/a                                       |
| Project allows cloud                                   | Turn it off. Existing cloud threads keep running, new ones can't start                             | Projects settings                                                                                                                          | yes          | read-only          | Launch refused with reason                |
| Driver configured                                      | Remove it. Threads with machines go to `failed` with code `driver-removed`                         | Settings → Cloud                                                                                                                           | yes          | read-only          | n/a                                       |
| Driver left on a non-cloud-only server (M2)            | Remove it; its cloud threads stay readable                                                         | Settings → Cloud, "Cloud moved to Pair Cloud"                                                                                              | yes          | read-only          | Launch refused, pointing at Pair Cloud    |
| Cloud-only mode                                        | Restart the server without it. Existing cloud threads stay readable; new launches are refused (06) | Settings → Cloud → Overview                                                                                                                | yes          | read-only          | n/a                                       |
| Agent link to Pair Cloud (M3)                          | Unlink it on the Mac; removing the member on Pair Cloud also ends it                               | The Mac's linked environments ([LinkedEnvironmentsSettings.tsx](../../../apps/web/src/components/settings/LinkedEnvironmentsSettings.tsx)) | yes          | no                 | `t3_environment_unlink`                   |
| Continue in cloud (M3)                                 | Continue locally                                                                                   | "Continued in cloud" row linking to the cloud thread                                                                                       | yes          | yes                | The local-server method (open question 1) |
| Continue locally (M3)                                  | Continue in cloud                                                                                  | "Continued locally" row                                                                                                                    | desktop      | no                 | none                                      |
| Activate image build (M4)                              | Activate an older build                                                                            | History list                                                                                                                               | yes          | Active build shown | `t3_team_image_*`                         |
| SSH key added (Later)                                  | Remove key                                                                                         | Settings → Cloud → Access                                                                                                                  | yes          | no                 | n/a                                       |
| Terminal stopped by sleep                              | Wake restarts the shell, not the old process                                                       | `stoppedBy: "sleep"` row                                                                                                                   | yes          | yes                | n/a                                       |

`defaultsToCloud` stays in the schema so old clients keep decoding and keeping it (section 2).
A local project that defaults to Cloud, routed through the resolver, is Later.

Who can press what, from 01. The client hides what the server would refuse:

| Action                     | Owner                        | Admin       | Other member                                         |
| -------------------------- | ---------------------------- | ----------- | ---------------------------------------------------- |
| Wake, Retry                | yes                          | yes         | yes                                                  |
| Sleep now, Discard machine | yes                          | yes         | no, shown disabled with "Only the owner or an admin" |
| Continue in cloud          | yes (their own local thread) | n/a         | n/a                                                  |
| Continue locally           | yes, moves it                | gets a copy | gets a copy; the cloud thread stays live             |

## 8. Shared client logic in packages/client-runtime

One copy of each rule, used by web, desktop and mobile. The resolver and capability gating live
here so the three clients agree on where Cloud goes.

| Module            | Path                                                                                                                                                                                                                                                                                                                                                    | Adds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloud target      | new `state/cloudTarget.ts`                                                                                                                                                                                                                                                                                                                              | M2. For a draft's project, every connected environment's descriptor, settings and projects in, one answer out: a target (`environmentId`, `projectId`), "add this repo to Pair Cloud", or unavailable with one reason string (offline, origin not on github.com). The project itself when its environment reports `cloudLaunch`; otherwise the project in such an environment whose `repositoryGroupingKeyOf(repositoryIdentity)` matches, the key repository grouping already uses ([projectGrouping.ts](../../../packages/client-runtime/src/state/projectGrouping.ts)). No target when no connected environment reports `cloudLaunch`. Also the branch check from the local VCS status (no upstream: "Push <branch> first"; ahead: "N commits not pushed won't be included"), and the rule that auto balance and machine pickers skip `cloudLaunch` environments for non-cloud modes |
| Capabilities      | new helpers beside the resolver                                                                                                                                                                                                                                                                                                                         | `cloudLaunch` and `cloudImport` reads, each a pure function from the descriptor, in the pattern of [threadPullRequestCompatibility.ts](../../../packages/client-runtime/src/threadPullRequestCompatibility.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Availability      | `cloudAvailability` in [packages/shared/src/sandbox.ts](../../../packages/shared/src/sandbox.ts)                                                                                                                                                                                                                                                        | Stays in packages/shared because the server calls it too. Gains a `not-cloud-only` reason: clients pass the descriptor's `cloudLaunch`, the server its own mode. The resolver calls it per candidate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Account readiness | [sandbox.ts](../../../packages/client-runtime/src/state/sandbox.ts)                                                                                                                                                                                                                                                                                     | M2. From the target's provider instances for the member, its company accounts and `cloudPushCredential`: ready, needs a provider account, or needs GitHub, each with the row to open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Project defaults  | `newThreadPrefersCloud` in [packages/shared/src/sandbox.ts](../../../packages/shared/src/sandbox.ts) (web's `useHandleNewThread.ts` and mobile's `use-new-task-project-defaults.ts` call it)                                                                                                                                                            | Landed in M1. Its callers stop reading it in M2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Shell rows        | [threadShell.ts](../../../packages/client-runtime/src/state/threadShell.ts), [shellReducer.ts](../../../packages/client-runtime/src/state/shellReducer.ts), [sandbox.ts](../../../packages/client-runtime/src/state/sandbox.ts)                                                                                                                         | Carry `sandbox` through; `sandboxStatePresentation(summary)` returns the label, tone and allowed actions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Detail            | [threadDetail.ts](../../../packages/client-runtime/src/state/threadDetail.ts)                                                                                                                                                                                                                                                                           | Apply `sandbox.updated` to the detail record                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Commands          | [runtime.ts](../../../packages/client-runtime/src/state/runtime.ts) `createEnvironmentRpcCommand` with `tag: dispatchCommand` and an `execute` that builds the command. Today's thread commands use `createEnvironmentCommand` in [threadCommands.ts](../../../packages/client-runtime/src/state/threadCommands.ts), which installs no permission guard | `wakeSandbox`, `sleepSandbox`, `retrySandbox`, `discardSandbox` over `orchestration.dispatchCommand` (M1). Continue in cloud and Continue locally over the local server's move RPCs; the local server, not the client, talks to Pair Cloud (M3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Permissions       | [commandPermissions.ts](../../../packages/client-runtime/src/state/commandPermissions.ts)                                                                                                                                                                                                                                                               | Atoms combining scope with owner or admin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Work log          | [turnItemPresentation.ts](../../../packages/client-runtime/src/state/turnItemPresentation.ts)                                                                                                                                                                                                                                                           | Provision steps; the timeline rows "Machine started from build 14", "Machine failed", "Machine discarded" (M1), "Continued in cloud" and "Continued locally" with a link across environments (M3), as turn item types old clients skip through `ForwardCompatibleUnion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Terminal          | [terminalSession.ts](../../../packages/client-runtime/src/state/terminalSession.ts)                                                                                                                                                                                                                                                                     | Asleep and `stoppedBy` states (M2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Usage             | `teamUsageAtom` in [team.ts](../../../packages/client-runtime/src/state/team.ts) ([usage.ts](../../../packages/client-runtime/src/state/usage.ts) is provider usage limits)                                                                                                                                                                             | `sandboxRows` (Later)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Push credential   | [sandbox.ts](../../../packages/client-runtime/src/state/sandbox.ts), [team.ts](../../../packages/client-runtime/src/state/team.ts)                                                                                                                                                                                                                      | `cloudPushCredential`: `app`, `owner` or `none`; token set and clear commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Viewer lease      | [presenceReporting.ts](../../../packages/client-runtime/src/presenceReporting.ts)                                                                                                                                                                                                                                                                       | Renew every 5 minutes while a cloud thread is visible (M2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

The permission atom for `sandbox.*`: the commands travel through `orchestration.dispatchCommand`,
which has no entry in `CLIENT_GUARDED_RPC_SCOPES` (the server requires
`AuthOrchestrationOperateScope` for every dispatch). `clientRpcRequiredScopes` has a branch, as
`gitPreparePullRequestThread` has, that returns `AuthOrchestrationOperateScope` for `sandbox.*`
command types, reading `input.type` without decoding the union. An unguarded `request` of one fails
(`RpcPermissionGuard` in [rpc/client.ts](../../../packages/client-runtime/src/rpc/client.ts)
denies by default), so these are `createEnvironmentRpcCommand`s. Owner-or-admin is a role check,
not a scope: the atom reads the thread's `ownerId` and the member's role, and the server checks
both again in `assertTeamPermission`
([ThreadMessageIntake.ts](../../../apps/server/src/orchestration-v2/ThreadMessageIntake.ts)), as
it does for `thread.delete`. Client commands join `OrchestrationV2Command`, the union
`dispatchCommand` decodes. Server-only ones join the unexported `OrchestrationV2InternalCommand`,
which that decode can't reach.

## 9. Work breakdown

PR-sized. "Parallel" means it can start when its milestone's first PR lands. Numbers are local;
[10](./10-delivery-plan.md) assigns delivery IDs (0.1 here is its 0.11; 0.4 is part of its 1.37).
Where a row takes over a PR from [m2-m5.md](./implementation/m2-m5.md), it names the old id.

### M0, the seam (landed)

| #   | PR                                                                                      | Parallel |
| --- | --------------------------------------------------------------------------------------- | -------- |
| 0.1 | Split `OrchestrationV2RunWorkspacePreparation` from the launch strategy. No new literal | first    |
| 0.2 | Moved to M1 1.7 and 1.10: a literal no code reads would be dead until then              | n/a      |
| 0.3 | Dropped: settings gated Cloud in M1                                                     | n/a      |
| 0.4 | Moved to M1 1.6: an export with no importer fails knip                                  | n/a      |

### M1, Docker cloud threads (landed)

| #    | PR                                                                                                                                                        | Parallel                            |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 1.1  | `sandbox.ts`, thread `sandboxId`, shell summary, detail record, `sandbox.updated`, commands (with 04's PR 1)                                              | first                               |
| 1.2  | `runner.ts` and the `./runner` subpath (03's PR 1)                                                                                                        | yes                                 |
| 1.3  | `ServerSettings.sandbox` driver instances, project keys `sandboxAllowed`, `defaultsToCloud`                                                               | yes                                 |
| 1.4  | Cloud launch strategy member. MCP `t3_thread_launch`, `isolation: "cloud"`, `orchestrator_capabilities`, evals                                            | after 1.1                           |
| 1.5  | `t3 thread start --cloud`                                                                                                                                 | after 1.4                           |
| 1.6  | client-runtime presentation, commands, permission atoms                                                                                                   | after 1.1                           |
| 1.7  | Web: mode picker, drafts, send, sidebar icon                                                                                                              | after 1.6                           |
| 1.8  | Web: header, status line, banners, thread menu, palette, `chat.newCloud`                                                                                  | after 1.6, parallel with 1.7        |
| 1.9  | Web: Settings → Cloud (Overview; Compute with driver, size and read-only caps; Environment variables), project settings, GitHub App key in Source Control | after 1.3                           |
| 1.10 | Mobile: new task, header, sheet actions, list, work log, read-only machines page                                                                          | after 1.6, parallel with 1.7 to 1.9 |
| 1.11 | `machine-failed` notification kind and routing                                                                                                            | yes                                 |
| 1.12 | D1: `TeamMemberGitHub.source`, `team.githubTokenSet` and `team.githubTokenClear` with scope, the App key setting, `github-credential-missing`             | yes                                 |
| 1.13 | D1 clients: web member row and push notice; mobile Team row and notice                                                                                    | after 1.12 and 1.6                  |
| 1.14 | D6: `sandbox.baseImage` setting, shown in Compute and Overview                                                                                            | after 1.3                           |
| 1.15 | D5: read-only caps show team cap and starts per minute, no member cap                                                                                     | after 1.9                           |

### M2, Pair Cloud on Docker (first release)

| #    | PR                                                                                                                                                                                                                                                                                                | Parallel                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 2.1  | `capabilities.cloudLaunch` from cloud-only mode; `cloudAvailability` gains `not-cloud-only`; desktop and other non-cloud-only servers stop offering Cloud (refusal pointing at Pair Cloud, Settings → Cloud scoped to Pair Cloud, the desktop warning and the project Cloud default leave the UI) | first                        |
| 2.2  | Move `delegated_task.request` into `OrchestrationV2InternalCommand`, so no client can supply its `sandbox`                                                                                                                                                                                        | yes                          |
| 2.3  | Member redaction of driver config in the settings stream                                                                                                                                                                                                                                          | yes                          |
| 2.4  | client-runtime Cloud-target resolver and capability helpers; auto balance and machine pickers skip `cloudLaunch` environments for non-cloud modes                                                                                                                                                 | after 2.1                    |
| 2.5  | Web and desktop: routed Cloud on local projects (mode picker, drafts, send, launch options from Pair Cloud, the branch check, palette, `chat.newCloud`)                                                                                                                                           | after 2.4 and 2.13           |
| 2.6  | Mobile: routed Cloud on Mac projects, the machine picker rule                                                                                                                                                                                                                                     | after 2.4, parallel with 2.5 |
| 2.7  | Pair Cloud projects: optional `destinationPath`, clone by origin on a cloud-only server, **Add to Pair Cloud** from the Cloud item                                                                                                                                                                | yes                          |
| 2.8  | Account onboarding notice on web and mobile; "Connect GitHub to clone private repos"                                                                                                                                                                                                              | after 2.5                    |
| 2.9  | Viewer lease from presence reporting (old 2.1)                                                                                                                                                                                                                                                    | yes                          |
| 2.10 | Terminal asleep state and `stoppedBy`, web and mobile (old 2.8)                                                                                                                                                                                                                                   | yes                          |
| 2.11 | Scheduled tasks and webhooks on Pair Cloud: Cloud placement, `discardOnSettle`, waiting history, web and mobile (old 2.18)                                                                                                                                                                        | after 2.1                    |
| 2.12 | Phone pushes from any Pair Cloud: Pair's own app build, pushes from a cloud-only server's first member, then the decisions.md and team-push.md updates                                                                                                                                            | yes                          |
| 2.13 | `existingBranch` on the cloud strategy and the `branch-not-pushed` refusal in place of the fallback to `origin/<base>` (with 07)                                                                                                                                                                  | yes                          |
| 2.14 | M3 prep: `historyOrigin` decodes unknown values as absent                                                                                                                                                                                                                                         | yes                          |

### M3, continue in cloud

| #   | PR                                                                                                                                                                     | Parallel          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| 3.1 | The agent link (D14): member-scoped peer link from the laptop to Pair Cloud; RemoteDelegation takes `cloud` for a `cloudLaunch` target; evals                          | first             |
| 3.2 | `capabilities.cloudImport`; `seedRef` on the cloud strategy; the staged-seed route, authenticated through the link (with 07)                                           | after 3.1         |
| 3.3 | The context export type with provenance, `contextExportRef`, the imported-history `historyOrigin` value, read-only history                                             | parallel with 3.2 |
| 3.4 | Continue in cloud on web and desktop: the local server's preview and move RPCs, thread menu, palette, "Continued in cloud" row, and the laptop agents' tool with evals | after 3.2 and 3.3 |
| 3.5 | Continue locally on desktop: download and local import, the owner's move and everyone else's copy (old 4.6, reshaped)                                                  | after 3.4         |
| 3.6 | Mobile: Continue in cloud on a Mac thread                                                                                                                              | after 3.4         |

### M4, team images

| #   | PR                                                   | Parallel                     |
| --- | ---------------------------------------------------- | ---------------------------- |
| 4.1 | `sandboxImage.ts` and `teamImage.*` RPCs with scopes | first                        |
| 4.2 | Settings → Cloud → Team image page and build log     | after 4.1                    |
| 4.3 | MCP `sandboxImage` toolkit and evals                 | after 4.1, parallel with 4.2 |
| 4.4 | Build pushes and their routing rule                  | after 4.1                    |
| 4.5 | Mobile: active build on the machines page            | after 4.1                    |

### M5, BYOC on AWS

| #   | PR                                                                                                                                                            | Parallel |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 5.1 | The `aws-ec2` member of the driver settings union, with every key past `kind`, `id`, `label` and `size` optional for member redaction; `gce` follows with GCP | yes      |
| 5.2 | `limits.cloud` (`cloudOnly`, `allowedDrivers`); read-only policy rows on web and mobile                                                                       | yes      |
| 5.3 | Driver health in Overview, including the network path check (09)                                                                                              | yes      |

### Later, by demand

Not scheduled: open in editor and `RemoteOpenTargetKind` `sandbox`, with Settings → Cloud → Access;
preview "Stopped while asleep"; usage `sandboxRows` with editable caps and a member cap; choosing a
machine size at launch; member env vars and masking; a local project that defaults to Cloud; the
provider picker marking OpenCode, Grok and Kiro as cloud-ready; the hosted vendor driver.

## Open questions

1. **Which MCP tool carries Continue in cloud for laptop agents?** Not `t3_thread_transfer` as it
   is: that tool forks and merges context between threads on one server. Proposed: a thread-toolkit
   tool on the laptop that calls the local server's move method, named and described with its evals
   in 3.4.
2. **What if several Pair Cloud environments hold the same origin?** A member in two teams, or a
   staging Pair Cloud beside the real one. Proposed: the Cloud item lists each by environment label;
   with one, there is no choice.
3. **Fork workflows.** `checkoutInSandbox` looks only at `origin/<branch>`, so a branch pushed to a
   fork ends in `branch-not-pushed`. Proposed (07): the launch names the branch's remote and the
   machine fetches from it; until then the branch check warns when the upstream isn't `origin`.
4. **Should mobile get Continue in cloud in M3?** Proposed: yes. The Mac's local server does the
   bundling, so the phone only drives the same commands; the seed preview becomes a sheet.
   Continue locally stays desktop.
5. **Should the GitHub App's installation token serve PR list and panel reads where the App is
   installed?** Today `GitHubRequestPolicy` needs the server's own GitHub sign-in, so a cloud
   session's PR panel on Pair Cloud depends on it.
6. **Can a laptop agent start a cloud session from unpushed work through the agent link?**
   Proposed: yes, through the same seed upload as Continue in cloud, once 3.2 lands.
7. **Only github.com is supported.** The resolver says so for any other origin. GitHub Enterprise
   Server and in-VPC GitLab customers are blocked.
8. **Do webhook routes belong on BYOC's optional public listener?** Webhooks on a private Pair Cloud
   can't be reached from GitHub (09).
9. **Should an agent be able to discard a machine?** No. Wake is implicit; discard stays human.

## Conflicts found

1. **Cloud-only as a switch.** [06](./06-credentials-and-security.md) §10 had an admin turn cloud-only
   mode on and off, and managed policy force it. Capabilities are fixed at startup, and a
   mixed-mode server is rejected, so this doc treats cloud-only as how a Pair Cloud server starts:
   leaving it means a restart (section 7). Managed policy can still require it (M5).
2. **Cloud as a scheduled task strategy.** Tasks never take `cloud`, and on Pair Cloud they don't
   need to: the gate places every run. [01](./01-product.md) J7 now says the same.
3. **Which commands clients can forge.** [progress.md](./implementation/progress.md) (maintainer
   answer 2) names `sandbox.provision`, `sandbox.created` and `sandbox.runner.attached` as
   client-dispatchable. They are in `OrchestrationV2InternalCommand`, which `dispatchCommand`
   can't decode. The real hole is `delegated_task.request.sandbox`, closed in M2 when the command becomes
   internal (section 2).
4. **One app build.** [decisions.md](../decisions.md) and
   [Team push notifications](../../operations/team-push.md) say each team builds its own mobile
   app. The plan's decision is one Pair-published build any Pair Cloud can notify. Those two docs
   change when 2.12 ships.
5. **A prompt for phones paired only with the Mac.** Dropped: nothing tells such a phone that a Pair
   Cloud exists, and prompting everyone would break "Local stays T3 Code". The phone shows Cloud
   once it is paired with an environment that reports `cloudLaunch`.
