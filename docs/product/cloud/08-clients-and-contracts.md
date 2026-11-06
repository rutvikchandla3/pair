# 08 Clients and contracts

Status: proposal, 2026-11-06. Audience: whoever changes `packages/contracts` or a client for Pair
Cloud. Words, decisions and milestones come from the [plan](./README.md). Code says `sandbox`. The
UI says "Cloud" for the mode and "machine" for a sandbox.

This doc owns the wire. Docs 01 to 07 and 09 say what the server does. This one says what crosses
the WebSocket, how older clients survive it, and where each client shows it. Where they disagree,
the last section names the conflict and picks a side.

## 1. Contract inventory

Every new or changed contract file, the doc that owns its behavior, and its milestone.

| File in `packages/contracts/src` | Change | Behavior owner | Milestone |
| --- | --- | --- | --- |
| [environment.ts](../../../packages/contracts/src/environment.ts) | Nothing. `ThreadEnvMode` is unchanged, and no capability is added (section 2, rule 3) | README decision 7, this doc | n/a |
| [orchestrationV2.ts](../../../packages/contracts/src/orchestrationV2.ts) | Launch strategy `cloud`; run preparation split; thread `sandboxId`; detail `sandbox`; shell `sandbox` summary; client and internal `sandbox.*` commands, including `sandbox.runner.attached` and `sandbox.runner.lost`; `sandbox.updated` | 03, 04 | M0 (split), M1 |
| `sandbox.ts` (new) | `SandboxId`, `SandboxState`, `SandboxSize`, `ComputeDriverId`, failure codes, `SandboxAsleep` error | 04, 07 | M1 |
| [orchestrationProject.ts](../../../packages/contracts/src/orchestrationProject.ts), [project.ts](../../../packages/contracts/src/project.ts) | None. Their `defaultThreadEnvMode` is legacy: the server folds it into project overrides once (`projectSettingsFolded`), and clients read the overrides (section 2) | this doc | n/a |
| [settings.ts](../../../packages/contracts/src/settings.ts) | `ServerSettings.sandbox` (an array of driver instances, a tagged union per kind; caps; env layers; `baseImage`), project override keys `sandboxAllowed`, `defaultsToCloud` (the project's sibling flag) | 04, 06, 09, D6 | M1, M2 (member env), M5 (`aws-ec2`) |
| `runner.ts` (new, subpath `./runner`) | Runner protocol. Never imported by client bundles | 03 | M1 |
| [package.json](../../../packages/contracts/package.json) | Export `./runner` next to `./settings` and `./relay` | 03 | M1 |
| [clientRpcPermissions.ts](../../../packages/contracts/src/clientRpcPermissions.ts) | Scopes for new RPCs; `sandbox.*` dispatch rule | this doc | M1 |
| [scheduledTask.ts](../../../packages/contracts/src/scheduledTask.ts) | Takes the cloud strategy through the shared union | 01, 04 | M2 |
| [terminal.ts](../../../packages/contracts/src/terminal.ts) | Optional `stoppedBy` on the session snapshot | 07 | M2 |
| [team.ts](../../../packages/contracts/src/team.ts) | `TeamMemberGitHub.source` (D1); `TeamUsageResult.sandboxRows` (section 2) | 06, 04 | M1, M2 |
| [server.ts](../../../packages/contracts/src/server.ts) | Nothing: `ServerConfig.settings` already carries `ServerSettings.sandbox` (proposed) | this doc | n/a |
| `sandboxImage.ts` (new) | `TeamImageRecipe`, `TeamImageBuild`, `teamImage.*` RPCs | 05 | M3 |
| [editor.ts](../../../packages/contracts/src/editor.ts) | `RemoteOpenTargetKind` gains `sandbox` | 07 | M4 |
| [managedPolicy.ts](../../../packages/contracts/src/managedPolicy.ts) | `limits.cloud` in `ManagedPolicyLimits` and the summary | 01, 09 | M4 (cloud-only), M5 (drivers) |
| [keybindings.ts](../../../packages/contracts/src/keybindings.ts) | `chat.newCloud` command | 01 | M1 |
| [rpc.ts](../../../packages/contracts/src/rpc.ts) | `team.githubTokenSet`, `team.githubTokenClear` (D1); team images, bundle read | 06, 05, 07 | M1, M3, M4 |

Naming resolutions, applied in every row above:

| Concept | Code name | UI name | Rejected |
| --- | --- | --- | --- |
| Thread mode | launch strategy `{type: "cloud"}`; client-local composer modes | Cloud | `remote`, `hosted`; a new `ThreadEnvMode` literal |
| Compute unit | `sandbox`, `SandboxId` | machine | `environment`, `vm`, `workspace` |
| Image the team builds | `TeamImageBuild` in `sandboxImage.ts` | team image, "build 14" | `snapshot` (a driver strategy) |
| Runner bundle version | `runnerBuildId` | not shown | bare `buildId`, `runnerBuildHash` |
| Image build on a sandbox | `imageBuildId` | build 14 | bare `buildId` |
| Cloud thread | a thread with a `sandboxId` | cloud thread | a `ThreadEnvMode` value |
| Driver instance | `ComputeDriverId`, several per server, one default per project | the driver's label | `provider` (taken by agent runtimes) |
| Availability gate | `ServerSettings.sandbox` present | none | a `capabilities` flag, which is fixed at startup |

Paths and route names follow the same rule. [apps/server/src/cloud/](../../../apps/server/src/cloud/)
and [apps/mobile/src/features/cloud/](../../../apps/mobile/src/features/cloud/) are T3 Connect. New
code goes in `sandbox` folders, and new UI files say `Sandbox` or `Machine` in their names.

## 2. Compatibility

### Rules

1. **Solo stays T3 Code.** With no driver configured, the server sends nothing new: no
   `ServerSettings.sandbox`, no `sandbox` keys on threads. Clients show nothing new.
2. **Additive only.** New fields are optional. New literals go only where older readers already
   tolerate unknown values. Nothing is renamed or removed.
3. **Gate by settings, not version (proposed).** Clients show Cloud when `ServerSettings.sandbox`
   lists a driver. Capabilities are fixed at startup ([ServerEnvironment.ts](../../../apps/server/src/environment/ServerEnvironment.ts)),
   but settings reach clients in the config snapshot and every `settingsUpdated`, redacted, so Cloud
   appears when an admin adds a driver, with no reconnect and nothing new until then.
4. **Newer clients against older servers** never send a `sandbox.*` command or a `cloud` strategy
   to a server whose settings lack `sandbox`. Old servers would reject the decode.

### How unknown values decode today

[baseSchemas.ts](../../../packages/contracts/src/baseSchemas.ts) has the tools.
`ForwardCompatibleOptional`, `ForwardCompatibleNullable` and `OmittedWhenNull` turn an unknown
value into absent or null. `ForwardCompatibleArray` drops elements it can't decode.
`ForwardCompatibleUnion` keeps unknown tagged members as `UnknownUnionMember`. A `Schema.Struct`
strips keys it doesn't know (`onExcessProperty` defaults to `"ignore"`, `.repos/effect` SchemaAST),
so new optional keys are safe, though a client that re-sends a whole struct drops them. A new
literal in a strict `Schema.Literals` is not safe.

The thread stream skips unknown event types (`OrchestrationV2UnknownThreadStreamEvent` in
[orchestrationV2.ts](../../../packages/contracts/src/orchestrationV2.ts)), so `sandbox.updated` is
safe. But "A known event type must decode in full": a `run.updated` an old client can't decode
fails the stream.

### Hazards found, and the fix for each

These are why `ThreadEnvMode` keeps its two values and `cloud` lives only in the launch input
(README decision 7).

| Wire site | Today | What a `cloud` value would do to an old client | Fix |
| --- | --- | --- | --- |
| `OrchestrationProjectShell.defaultThreadEnvMode` | strict, inside `projects: Schema.Array(...)` of the shell snapshot and in `project.updated` items | Fails the whole shell snapshot. No threads load | Never send `cloud` here. The field is legacy (`resolveProjectOverrides` in [projectSettings.ts](../../../packages/shared/src/projectSettings.ts) reads it only before `projectSettingsFolded`), so it gets no sibling |
| `Project`, `ProjectUpdatePayload` in [project.ts](../../../packages/contracts/src/project.ts) | strict | Fails project reads and updates | Same: never `cloud`, no new key |
| `ProjectSettingsOverrides.defaultThreadEnvMode` in [settings.ts](../../../packages/contracts/src/settings.ts) | `optionalKey(ThreadEnvMode)`, strict. `keepUnknownOverrideKeys` keeps unknown keys, not unknown values | Fails `ServerSettings`, so the server config | Sibling key `defaultsToCloud`. Old clients keep it through `keepUnknownOverrideKeys` when they edit (tested in `settings.test.ts`) |
| `ServerSettings.defaultThreadEnvMode` | `OmittedWhenNull` | Decodes to null: "no default" | Safe as is |
| [t3ProjectFile.ts](../../../packages/contracts/src/t3ProjectFile.ts) `defaultThreadEnvMode` | strict, in a file committed to the repo | Every older Pair and upstream T3 Code install reading the repo fails on it | Never offered |
| `OrchestrationV2Run.workspacePreparation` | strict union, inside every run in thread detail and `run.*` events | Cloud threads fail to open on old clients | Split the union (below) |
| `ScheduledTaskListResult.tasks` | `ForwardCompatibleArray` | The task disappears from old clients | Acceptable: they can't edit what they can't run |
| `TerminalSessionStatus` | strict literals | A new status fails terminal snapshots | 07's choice holds: `stoppedBy` is a new optional key, not a status |
| `RemoteOpenTarget` | `ForwardCompatibleArray` in `ServerConfig.remoteOpenTargets` | Dropped | Safe |
| `ResolvedKeybindingsConfig` | `ForwardCompatibleArray` in [keybindings.ts](../../../packages/contracts/src/keybindings.ts) | `chat.newCloud` dropped | Safe |
| `ManagedPolicyDocument` | rejects excess keys (`onExcessProperty: "error"` in [managedPolicyFile.ts](../../../packages/shared/src/managedPolicyFile.ts)) | An older server refuses a policy file with `limits.cloud` | Intended. Policy docs say which release reads it |

### The launch strategy split (M0)

One schema object, `OrchestrationV2ThreadLaunchWorkspaceStrategy`, types seven fields:
`OrchestrationV2ThreadLaunchInput`, MCP `t3_thread_launch` (which `t3 thread` calls),
`delegated_task.request`, `message.dispatch`'s `defer_start`, `ScheduledTask`,
`ScheduledTaskUpsertInput`, and `OrchestrationV2Run.workspacePreparation`. The orchestrator copies
`defer_start`'s strategy into the run as is, and delegation feeds `defer_start` directly. Only the
inputs need `cloud`. M0 gives the run and `defer_start` the new name. The members are identical, so
encoding, the MCP JSON schema and client imports don't change. Test as `auth.test.ts` freezes the
old scope vocabulary: freeze today's union, and in M1 decode a cloud launch's run with it.

```ts
// orchestrationV2.ts, M0: today's three members under a new name, used by runs
export const OrchestrationV2RunWorkspacePreparation = Schema.Union([Root, ExistingWorktree, Worktree]);

// M1: the launch input gains cloud
export const OrchestrationV2ThreadLaunchWorkspaceStrategy = Schema.Union([
  ...OrchestrationV2RunWorkspacePreparation.members,
  Schema.Struct({
    type: Schema.Literal("cloud"),
    baseRef: TrimmedNonEmptyString,
    branch: Schema.optional(TrimmedNonEmptyString),
    startFromOrigin: Schema.optional(Schema.Boolean),
    size: Schema.optional(SandboxSize),                 // M2
    discardOnSettle: Schema.optional(Schema.Boolean),   // M2, 01 J7
  }),
]);
```

A cloud run records `{ type: "worktree", baseRef, branch }`, because the checkout in a sandbox is
a worktree of the image's clone (05). Placement lives on the thread's `sandboxId`, so the retry path
(`ThreadLaunchService.scheduleRunPreparation`, which rebuilds the launch from the run record) and
cloud delegation (decided inside the orchestrator, not `ThreadLaunchService`) must read it there.
`orchestrationV2WorktreePending` stays correct. Old clients see a worktree thread whose path is
`/t3-sandbox/<sandboxId>/...` (02). Their "open in editor" opens that path on the team server's
machine ([remoteOpen.ts](../../../apps/web/src/remoteOpen.ts)), where it doesn't exist. That is
the accepted cost, and it is why section 4 hides local-only actions on new clients.

### Thread, shell and detail fields (M1)

```ts
// sandbox.ts
export const SandboxState = Schema.Literals([
  "provisioning", "ready", "sleeping", "waking", "failed", "destroyed",
]);

// orchestrationV2.ts
OrchestrationV2AppThread.fields.sandboxId = Schema.optionalKey(SandboxId);

export const OrchestrationV2ThreadShellSandbox = Schema.Struct({
  state: ForwardCompatibleNullable(SandboxState),  // a later state shows as "Machine status unknown"
  admission: Schema.optionalKey(Schema.Struct({ reason: SandboxAdmissionReason, since: IsoDateTime })),
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
stream must also re-emit the shells of side chats and forks sharing the sandbox (decision 6).

### Older clients, surface by surface

| Client | Sees a cloud thread as | Can do | Can't do |
| --- | --- | --- | --- |
| Desktop or mobile before M0 | A worktree thread | Read, prompt (sending wakes it, 04), review diffs, approve | Wake, retry, discard; see why it waits |
| Desktop or mobile after M0, server without a driver | Nothing new | Everything as today | n/a |
| Any client, older server | Nothing new | Everything as today | Cloud, which is hidden |
| app.t3.codes | Always the latest build | Everything | n/a |

Prompting from an old client works because a message to a sleeping sandbox wakes it on the server
(04). A failed sandbox fails the run, which old clients already show.

### Usage

Usage rows are keyed by member and provider instance, and machine time belongs to no instance, so
it is a separate optional array (04):

```ts
TeamUsageResult.fields.sandboxRows = Schema.optionalKey(Schema.Array(Schema.Struct({
  memberId: MemberId, sandboxSeconds: NonNegativeInt, size: SandboxSize,
})));
```

### A member's own GitHub token (D1, M1)

A cloud thread pushes with the App's installation token, else its owner's GitHub credential, else
not at all. The owner's credential is the existing device-flow link or a token they paste. The
contract follows the existing `team.githubLink*` and `team.githubDisconnect` methods in
[rpc.ts](../../../packages/contracts/src/rpc.ts):

```ts
// team.ts: old clients ignore the new key
TeamMemberGitHub.fields.source = Schema.optionalKey(Schema.Literals(["app", "token"]));

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
field in settings, never the key) and the owner's `TeamMember.github`. A push the server refuses for lack of a credential
fails with code `github-credential-missing`, which clients render as "Connect GitHub to push".

## 3. Performance on the client wire

| Data | How it travels | Rule |
| --- | --- | --- |
| Shell summary | `thread.updated` shell items | Five small fields. Only on state change. Never progress ticks |
| Runner connection | Shell `runnerConnected` | Only on change, debounced 2 s (03). A blip under 2 s sends nothing |
| Full sandbox record | Thread detail, `sandbox.updated` | Only to subscribers of that thread |
| Provision progress | `prepared-run.progress`, as worktree setup today: its `phase` sets the title of the run's "Preparing workspace" `command_execution` item, so new phases change no client schema | Steps, not percentages. Four labels (04) |
| Setup and build logs | `teamImage.subscribeBuildLog`, existing setup output | Streamed only while the page or panel is open |
| Viewer lease | One call every 5 minutes per open cloud thread (04) | Piggybacks on presence reporting in [presenceReporting.ts](../../../packages/client-runtime/src/presenceReporting.ts) |
| Usage | `team.usage` reads | On demand when the page opens. No stream |
| Asleep file reads | From the mirror (07) | Same RPCs and paging as today |

UI rules:

- "Starting machine" and "Waking machine" use a static icon and step text. No spinner that repaints
  continuously. Copy changes are the only motion.
- The sidebar row gets one icon and, at most, one short state word. No per-row timers.
- Admission position ("2 ahead of you") is not sent. It would update every waiting row on every
  admit. The count in the shell summary is enough.

## 4. Web and desktop

Desktop wraps the web app. Everything here applies to both unless marked.

### Where cloud appears

| Surface | Path | Change | Milestone |
| --- | --- | --- | --- |
| Mode picker | [BranchToolbarEnvModeSelector.tsx](../../../apps/web/src/components/BranchToolbarEnvModeSelector.tsx) | A **Cloud** item after New worktree, when available. The locked view shows a cloud icon from `sandboxId`, not from `activeWorktreePath` | M1 |
| Mode logic | [BranchToolbar.logic.ts](../../../apps/web/src/components/BranchToolbar.logic.ts) | The client-local `EnvMode` (line 26) gains `cloud`. `resolveEffectiveEnvMode` returns `cloud` when the thread has a `sandboxId` | M1 |
| Drafts | [composerDraftStore.ts](../../../apps/web/src/composerDraftStore.ts) | Draft mode can be `cloud`: its own persisted `DraftThreadEnvModeSchema` and `normalizeDraftThreadEnvMode` gain it. The default stays New worktree unless the project has `defaultsToCloud` (D4). Falls back when Cloud becomes unavailable | M1 |
| Send | [useComposerSend.ts](../../../apps/web/src/components/chat/useComposerSend.ts), [useHandleNewThread.ts](../../../apps/web/src/hooks/useHandleNewThread.ts) | Map `cloud` to the cloud launch strategy | M1 |
| Header and status | [ChatHeader.tsx](../../../apps/web/src/components/chat/ChatHeader.tsx), [ThreadStatusLine.tsx](../../../apps/web/src/components/chat/ThreadStatusLine.tsx) | State text and actions from section 7 | M1 |
| Failure and asleep notices | [ComposerBanner.tsx](../../../apps/web/src/components/chat/ComposerBanner.tsx) slots via [useSystemComposerBanners.tsx](../../../apps/web/src/components/chat/useSystemComposerBanners.tsx) | Per [Web UI](../../internals/web-ui.md): composer notices use the banner slots | M1 |
| Thread details | [ThreadDetailsPanel.tsx](../../../apps/web/src/components/chat/ThreadDetailsPanel.tsx) | Machine section: driver, size, image build, uptime | M1, image M3 |
| Sidebar | [SidebarThreadRow.tsx](../../../apps/web/src/components/sidebar/SidebarThreadRow.tsx) | Cloud icon. "Asleep", "Waiting" or "Failed" word | M1 |
| Thread menu | [useThreadActionMenu.ts](../../../apps/web/src/hooks/useThreadActionMenu.ts), [chatThreadActions.ts](../../../apps/web/src/lib/chatThreadActions.ts) | Wake, Sleep now, Retry, Discard machine; Continue locally, Continue in cloud | M1, M4 |
| Command palette | [CommandPalette.tsx](../../../apps/web/src/components/CommandPalette.tsx), [CommandPaletteThreadItems.tsx](../../../apps/web/src/components/CommandPaletteThreadItems.tsx) | "New cloud thread", and the thread menu's actions for the active thread | M1, M4 |
| Keybinding | [chatRouteCommands.ts](../../../apps/web/src/shortcuts/chatRouteCommands.ts) | `chat.newCloud` in `STATIC_KEYBINDING_COMMANDS`, next to `chat.newLocal`. No default binding in [keybindings.ts](../../../packages/shared/src/keybindings.ts) | M1 |
| Terminal | [ThreadTerminalDrawer.tsx](../../../apps/web/src/components/ThreadTerminalDrawer.tsx) | Stopped Docker machine: terminals show exited (M1). Asleep: read-only with **Wake**; typing wakes, viewing doesn't (M2) | M1, M2 |
| Preview | [preview/](../../../apps/web/src/components/preview/) | "Stopped while asleep" with **Restart** (01 J6) | M2 |
| Diffs | [DiffPanel.tsx](../../../apps/web/src/components/DiffPanel.tsx) | Unchanged. While stopped, reads fall back to the mirror's latest checkpoint (M1). Snapshot browsing is M2 | M1, M2 |
| Worktree setup | [useWorktreeSetup.ts](../../../apps/web/src/components/chat/useWorktreeSetup.ts) | Skips local worktree prompts when the thread has a `sandboxId` | M1 |
| Open in editor | [OpenInPicker.tsx](../../../apps/web/src/components/chat/OpenInPicker.tsx); [remoteOpen.ts](../../../apps/web/src/remoteOpen.ts) resolves per environment, not per thread | Local path actions hidden for cloud threads until M4. Then the `sandbox` target over SSH | M1 hide, M4 |
| Usage | [MemberUsage.tsx](../../../apps/web/src/components/team/MemberUsage.tsx), where team usage shows today ([_chat.usage.tsx](../../../apps/web/src/routes/_chat.usage.tsx) is provider usage limits) | Machine hours per member from `sandboxRows` | M2 |
| Projects | [ProjectDefaultsSettings.tsx](../../../apps/web/src/components/settings/ProjectDefaultsSettings.tsx) | "Allow cloud threads" and Cloud as a project default | M1 |
| Scheduled tasks | [ScheduledTasksSettings.tsx](../../../apps/web/src/components/settings/ScheduledTasksSettings.tsx) | **Cloud** in the task's placement choice; "Discard machine when the run settles" | M2 |
| GitHub App key | [SourceControlSettings.tsx](../../../apps/web/src/components/settings/SourceControlSettings.tsx) | App ID and private key (06) | M1 |
| Member GitHub | [MemberGitHub.tsx](../../../apps/web/src/components/team/MemberGitHub.tsx) | On the member's own row in Settings → Team: **Use a token instead** next to Connect GitHub, **Remove token**, and the warning that agents can read it until M3's git proxy (D1) | M1 |
| Push notice | ComposerBanner slots | "Connect GitHub to push", linking the owner to their row; others see "Ask <owner> to connect GitHub" | M1 |

### Settings → Cloud

A new top-level page, `/settings/cloud`, in `SETTINGS_NAV_GROUPS` of
[settingsSearch.ts](../../../apps/web/src/components/settings/settingsSearch.ts), rendered by
[SettingsSidebarNav.tsx](../../../apps/web/src/components/settings/SettingsSidebarNav.tsx). It sits
after Team and shows on solo servers too, unlike Team, which `useTeamSettingsVisible` in
[team.ts](../../../apps/web/src/state/team.ts) hides. Each sub-page is a section on one route, as
other settings pages are, so search can reach them.

| Section | Holds | Who edits | Milestone |
| --- | --- | --- | --- |
| Overview | Driver health, running machines, base image in use, mirror size, the Docker isolation warning, the desktop-server warning (07, 01) | Admins; members read | M1 |
| Compute | Driver instances, machine size and the `sandbox.baseImage` override (M1, D6); read-only caps in M1: team cap and starts per minute, no member cap (D5); caps editable, member cap optional in M2; idle period and retention from 04 (M2) | Admins | M1, M2 |
| Environment variables | Team layer, reserved names (06) | Admins | M1 |
| Team image | Recipe, builds, history, activate (05) | Admins | M3 |
| Usage | Machine hours per member | Admins | M2 |
| Access | SSH keys and "Allow SSH into machines" (07) | Each member; the switch is admin | M4 |
| Policy | Cloud-only mode, read-only rows from managed policy | Admins | M4, M5 |

Settings → Access already exists ([_chat.settings.access.tsx](../../../apps/web/src/routes/_chat.settings.access.tsx)).
The SSH section is titled "Machine access" so search doesn't mix the two. Project env vars sit in
the project's settings (06). Member env vars sit in Settings → Cloud → Environment variables under
"Yours" (M2). A project defaults to Cloud through `defaultsToCloud` in its settings (01).

### Every entry point per action

| Action | Composer | Thread menu | Command palette | Keybinding | Header or banner | Settings | MCP and CLI | Milestone |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Start in cloud | Mode picker **Cloud** | n/a | "New cloud thread" | `chat.newCloud` | n/a | Project `defaultsToCloud` (admin) | `t3_thread_launch`, `create_threads`, `delegate_task`, `t3 thread start --cloud` | M1 |
| Wake machine | Sending wakes | **Wake** | "Wake machine" | none | **Wake** in the asleep notice | n/a | Any thread tool that needs the machine (04) | M1 manual, M2 triggers |
| Sleep now | n/a | **Sleep now** | "Sleep machine" | none | n/a | Idle period | none | M1 |
| Retry | n/a | **Retry** | "Retry machine" | none | **Retry** in the failure notice | n/a | none | M1 |
| Discard machine | n/a | **Discard machine** | "Discard machine" | none | **Discard** in the failure notice | Retention | none | M1 |
| Bring it local | n/a | **Continue locally** | "Continue locally" | none | n/a | n/a | `t3_thread_move` (section 6) | M4 |
| Send to cloud | n/a | **Continue in cloud** | "Continue in cloud" | none | n/a | n/a | `t3_thread_move` | M4 |
| Connect GitHub to push | n/a | n/a | n/a | none | Push notice links to the row | Team → own row: Connect GitHub or **Use a token instead** | none | M1 |
| Remove own token | n/a | n/a | n/a | none | n/a | Team → own row: **Remove token** | none | M1 |

Each action is a `createEnvironmentRpcCommand` in client-runtime (section 8). Web, desktop and
mobile call the same command. The menu, palette and banner read the same permission atom, so they
agree on what is offered.

### Desktop only

- **Continue locally on this computer (M4).** 07's flow: the desktop app asks the team server for a
  bundle, then hands it to its own bundled server. The bridge is a new IPC method in
  [apps/desktop/src/ipc/](../../../apps/desktop/src/ipc/), because the web client can't write to the
  local server's disk (inferred). Web without desktop offers only "on the team server".
- **Open in editor (M4).** `t3 ssh setup` writes the SSH config (07). Desktop opens the
  `vscode-remote` URL built in [editor.ts](../../../packages/contracts/src/editor.ts).
  [DesktopSshEnvironment.ts](../../../apps/desktop/src/ssh/DesktopSshEnvironment.ts) connects to
  remote T3 servers and is unrelated. Don't reuse its name.
- **Desktop as team server.** Settings → Cloud → Overview warns that closing the laptop stops cloud
  turns (07).

## 5. Mobile

Navigation follows [Mobile navigation](../../internals/mobile-navigation.md): opening a cloud thread
is a select, through
[workspace-detail-selection.ts](../../../apps/mobile/src/features/workspace/workspace-detail-selection.ts).
Settings pages share one native screen.

| Screen or flow | Path | Change | Milestone |
| --- | --- | --- | --- |
| New task mode | [NewTaskContextPickerScreens.tsx](../../../apps/mobile/src/features/threads/NewTaskContextPickerScreens.tsx); `WorkspaceMode` in [new-task-flow-provider.tsx](../../../apps/mobile/src/features/threads/new-task-flow-provider.tsx) and [new-task-context-presentation.ts](../../../apps/mobile/src/features/threads/new-task-context-presentation.ts), and inline `"local" \| "worktree"` in `NewTaskDraftScreen.tsx`, `checkout-new-task-branch.ts`, `projectThreadCreationValidation.ts` | The client-local mode gains `cloud`. **Cloud** row when available. Base branch picker as for worktree | M1 |
| Thread header | [ThreadHeader.tsx](../../../apps/mobile/src/features/threads/ThreadHeader.tsx) | State text, as on web | M1 |
| Thread actions | [ThreadSettingsSheet.tsx](../../../apps/mobile/src/features/threads/ThreadSettingsSheet.tsx) | Wake, Retry, Sleep now, Discard machine | M1 |
| Thread list | [thread-list-v2-items.tsx](../../../apps/mobile/src/features/threads/thread-list-v2-items.tsx) | Cloud icon and state word | M1 |
| Work log | [thread-work-log.tsx](../../../apps/mobile/src/features/threads/thread-work-log.tsx) | Provision steps from `prepared-run.progress` | M1 |
| Terminal | [ThreadTerminalRouteScreen.tsx](../../../apps/mobile/src/features/terminal/ThreadTerminalRouteScreen.tsx) | Exited while stopped (M1). Read-only asleep state with **Wake** (M2) | M1, M2 |
| Scheduled tasks | [SettingsScheduledTasksRouteScreen.tsx](../../../apps/mobile/src/features/settings/SettingsScheduledTasksRouteScreen.tsx), [scheduledTaskDraft.ts](../../../apps/mobile/src/features/settings/scheduledTaskDraft.ts) | Cloud as a placement choice | M2 |
| Usage | [UsageRouteScreen.tsx](../../../apps/mobile/src/features/usage/UsageRouteScreen.tsx) | Machine hours. It shows provider usage only today; mobile has no team usage yet | M2 |
| Cloud status page | New `SettingsMachinesRouteScreen.tsx` beside [SettingsTeamRouteScreen.tsx](../../../apps/mobile/src/features/settings/SettingsTeamRouteScreen.tsx). A page is registered in [Stack.tsx](../../../apps/mobile/src/Stack.tsx), listed in [SettingsRouteScreen.tsx](../../../apps/mobile/src/features/settings/SettingsRouteScreen.tsx), and named in `settings-page-targets.ts` and `settings-search.ts`; [settings-navigation.ts](../../../apps/mobile/src/features/settings/settings-navigation.ts) derives routes from the `Settings*` names | Read-only: driver health, running machines, active image build | M1, M3 |
| Member GitHub | [SettingsTeamRouteScreen.tsx](../../../apps/mobile/src/features/settings/SettingsTeamRouteScreen.tsx) | Own row, which shows no GitHub today: GitHub source, **Use a token instead** (secure paste field), **Remove token** | M1 |
| Push notice | [ThreadDetailScreen.tsx](../../../apps/mobile/src/features/threads/ThreadDetailScreen.tsx) | "Connect GitHub to push", opening the Team screen | M1 |
| Open in editor | Thread sheet | "Open on a computer" explains SSH (07) | M4 |

The new mobile code goes under `features/threads` and `features/settings`, never
`features/cloud`, which is T3 Connect.

Mobile leaves out, by design:

- Driver, caps, env var and policy editing. These are admin tasks with secrets.
- Team image recipe editing and build logs. Mobile shows the active build and pushes.
- SSH keys and open in editor.
- Continue locally to "this device". A phone has no local server.
- Continue locally and Continue in cloud in M4. Mobile can add them later through the same
  commands, since they need no local disk on the team server path (inferred).

Pushes: "Machine failed" joins `ThreadNotificationKind` in
[threadNotificationRouting.ts](../../../packages/shared/src/threadNotificationRouting.ts) as
`machine-failed`, routed like `failed` (M1). Build pushes (M3) get their own routing function
there, because they have no thread. They go to the admin who started the build, or to the admins
who prompted the image thread (01).

## 6. Agents and automation

### MCP launch tools (M1)

Agents reach cloud through the same tools users' agents use today.

| Tool | File | Change |
| --- | --- | --- |
| `t3_thread_launch` | [project/tools.ts](../../../apps/server/src/mcp/toolkits/project/tools.ts) | `workspaceStrategy` takes `{type:"cloud", baseRef}`; the description gains one clause |
| `delegate_task` | [orchestrator/tools.ts](../../../apps/server/src/mcp/toolkits/orchestrator/tools.ts), `OrchestratorMcpDelegateTaskInput` in [orchestratorMcp.ts](../../../packages/contracts/src/orchestratorMcp.ts) | `isolation` gains `"cloud"` beside `shared` and `worktree` |
| `create_threads` | same | Has no `isolation` today: its threads inherit the caller's checkout. Cloud needs a new optional key |
| `orchestrator_capabilities` | same | Reports whether cloud is available here (a `features` key), so an agent asks before it launches |
| `t3_thread_read` | same | Returns the shell `sandbox` summary |
| `t3_thread_move` (new) | [thread/tools.ts](../../../apps/server/src/mcp/toolkits/thread/tools.ts) | Continue locally and Continue in cloud (M4). Not `t3_thread_transfer`, which forks and merges context between threads (open question 2) |
| `t3_team_image_*` | `apps/server/src/mcp/toolkits/sandboxImage/` (new) | 05's six tools (M3) |

These descriptions are model-facing text. Changing them means running the evals named in
[evals/README.md](../../../evals/README.md), and adding a case where a model must pick cloud for
"run this where my laptop can sleep" (M1).

Permission checks, all on the server:

- Launch: `McpToolAccess` in [McpToolAccess.ts](../../../apps/server/src/mcp/McpToolAccess.ts)
  already checks the caller and its mode ceiling. Add: the project allows cloud, the team is under
  its cap and start rate (no member cap by default, D5), and managed policy allows the driver. At a cap, launch succeeds
  and the child waits (01 J7).
- Wake, sleep, retry, discard: no MCP tool in M1. Thread tools that need the machine wake it (04).
  Discard stays a human decision.
- Team image tools: admin only, as `AuthSettingsWriteScope` guards their RPCs.

### `t3 thread` (M1)

[cli/thread.ts](../../../apps/server/src/cli/thread.ts) calls `t3_thread_launch` with a
`workspaceStrategy` built from `--worktree` and `--branch`. Add one flag:

```text
t3 thread start api "fix flaky test" --cloud main [--branch fix/flaky]
```

`--cloud <ref>` mirrors `--worktree <ref>`. The two are mutually exclusive. `--wait` works
unchanged. A waiting machine prints "Waiting for a machine" to stderr once. `t3 thread show`
prints the machine state line.

### Scheduled tasks and webhooks (M2)

Tasks reuse `OrchestrationV2ThreadLaunchWorkspaceStrategy`, so the cloud member reaches them with no
new task field. `discardOnSettle` is part of the strategy. Run history shows "Waiting for a
machine" from the run's admission state. Old clients don't list cloud tasks (section 2), so no old
client can save a task and drop its cloud strategy.

### Peer links

An agent on one server can launch on a linked server: `t3_thread_launch` with `environmentId`, or
`delegate_task` with `target.environmentId`, which
[RemoteDelegation.ts](../../../apps/server/src/peer/RemoteDelegation.ts) turns into a
`t3_thread_launch` there with `delegatedFrom` set. Both go out through
[PeerForwarding.ts](../../../apps/server/src/peer/PeerForwarding.ts). RemoteDelegation refuses
`isolation: "worktree"` today and sends no strategy, so `"cloud"` there needs its own rule. The
target decides placement with its own drivers, caps and policy. Rules:

- An agent asks `orchestrator_capabilities` for the target before sending `cloud`.
- A target without `ServerSettings.sandbox` rejects the strategy decode. The caller gets the existing typed
  failure, not a silent fallback to a worktree.
- The caller's cap does not apply on the target. The target's member mapping does (inferred, since
  peer links map callers already).

## 7. Reverse states on every surface

Every way in has a way out and a way to see it.

| Way in | Way out | Where you see it | Web, desktop | Mobile | MCP, CLI |
| --- | --- | --- | --- | --- | --- |
| Start in cloud | Discard machine, or Continue locally (M4) | Cloud icon, header state | yes | yes | Launch only |
| Sleep (idle, manual, or Docker once all threads settle in M1) | Wake, send, open thread | "Asleep" | yes | yes | Thread tools wake |
| Failed | Retry, or Discard | Failure notice with reason | yes | yes | `t3_thread_read` shows it |
| Waiting at a cap | Admission, or Discard a machine | "Waiting for a machine" | yes | yes | Launch result and read |
| Discarded | **Start a new machine** focuses the composer; sending provisions | "Machine discarded" | yes | yes | Launch or send |
| Project defaults to Cloud | An admin clears `defaultsToCloud` | Settings → Projects | yes | read-only | n/a |
| Own GitHub token set (D1) | **Remove token**; the thread then shows "Connect GitHub to push" | Own row in Settings → Team | yes | yes | n/a |
| "Connect GitHub to push" | Connect GitHub, or **Use a token instead** | Push notice on the thread | yes | yes | Push error `github-credential-missing` |
| Base image override | Clear `sandbox.baseImage`; the version-matched image returns | Settings → Cloud → Compute | yes | read-only | n/a |
| Project allows cloud | Turn it off. Existing cloud threads keep running, new ones can't start | Projects settings | yes | read-only | Launch refused with reason |
| Driver configured | Remove it. Threads with machines go to `failed` with code `driver-removed` | Settings → Cloud | yes | read-only | n/a |
| Cloud-only mode (M4) | Turn it off (06) | Settings → Cloud → Policy | yes | read-only | n/a |
| Continue in cloud (M4) | Continue locally | Timeline row "Continued in cloud" | yes | not in M4 | `t3_thread_move` |
| Activate image build (M3) | Activate an older build | History list | yes | Active build shown | `t3_team_image_*` |
| SSH key added (M4) | Remove key | Settings → Cloud → Access | yes | no | n/a |
| Terminal stopped by sleep | Wake restarts the shell, not the old process | `stoppedBy: "sleep"` row | yes | yes | n/a |

Who can press what, from 01. The client hides what the server would refuse:

| Action | Owner | Admin | Other member |
| --- | --- | --- | --- |
| Wake, Retry | yes | yes | yes |
| Sleep now, Discard machine | yes | yes | no, shown disabled with "Only the owner or an admin" |
| Continue locally, Continue in cloud | yes | yes | no |

## 8. Shared client logic in packages/client-runtime

One copy of each rule, used by web and mobile.

| Module | Path | Adds |
| --- | --- | --- |
| Availability | new `state/sandbox.ts` | `cloudAvailability(settings, projectId, policy)`: a configured driver, project allows, policy allows. One answer and one reason string for every picker |
| Project defaults | `resolveNewThreadEnvMode` in [projectSettings.ts](../../../packages/shared/src/projectSettings.ts) (packages/shared; web's `useHandleNewThread.ts` and mobile's `use-new-task-project-defaults.ts` call it) | Folds the `defaultsToCloud` override into the client-local mode |
| Shell rows | [threadShell.ts](../../../packages/client-runtime/src/state/threadShell.ts), [shellReducer.ts](../../../packages/client-runtime/src/state/shellReducer.ts) | Carry `sandbox` through; `sandboxStatePresentation(summary)` returns the label, tone and allowed actions |
| Detail | [threadDetail.ts](../../../packages/client-runtime/src/state/threadDetail.ts) | Apply `sandbox.updated` to the detail record |
| Commands | [runtime.ts](../../../packages/client-runtime/src/state/runtime.ts) `createEnvironmentRpcCommand` with `tag: dispatchCommand` and an `execute` that builds the command. Today's thread commands use `createEnvironmentCommand` in [threadCommands.ts](../../../packages/client-runtime/src/state/threadCommands.ts), which installs no permission guard | `wakeSandbox`, `sleepSandbox`, `retrySandbox`, `discardSandbox` over `orchestration.dispatchCommand` |
| Permissions | [commandPermissions.ts](../../../packages/client-runtime/src/state/commandPermissions.ts) | Atoms combining scope with owner or admin |
| Work log | [turnItemPresentation.ts](../../../packages/client-runtime/src/state/turnItemPresentation.ts) | Provision steps; the timeline rows "Machine started from build 14", "Machine failed", "Machine discarded", "Continued locally", "Continued in cloud" as one new turn item type, which old clients skip through `ForwardCompatibleUnion` |
| Terminal | [terminalSession.ts](../../../packages/client-runtime/src/state/terminalSession.ts) | Asleep and `stoppedBy` states |
| Usage | `teamUsageAtom` in [team.ts](../../../packages/client-runtime/src/state/team.ts) ([usage.ts](../../../packages/client-runtime/src/state/usage.ts) is provider usage limits) | `sandboxRows` |
| Push credential | [team.ts](../../../packages/client-runtime/src/state/team.ts) | `cloudPushCredential(thread, owner, settings)`: `app`, `owner` or `none`; token set and clear commands |
| Viewer lease | [presenceReporting.ts](../../../packages/client-runtime/src/presenceReporting.ts) | Renew every 5 minutes while a cloud thread is visible |

The permission atom for `sandbox.*`: the commands travel through `orchestration.dispatchCommand`,
which has no entry in `CLIENT_GUARDED_RPC_SCOPES` (the server requires
`AuthOrchestrationOperateScope` for every dispatch). Add a branch to `clientRpcRequiredScopes`, as
`gitPreparePullRequestThread` has, that returns `AuthOrchestrationOperateScope` for `sandbox.*`
command types, reading `input.type` without decoding the union. Then an unguarded `request` of one
fails (`RpcPermissionGuard` in [rpc/client.ts](../../../packages/client-runtime/src/rpc/client.ts)
denies by default), so these must be `createEnvironmentRpcCommand`s. Owner-or-admin is a role
check, not a scope: the atom reads the thread's `ownerId` and the member's role, and the server
checks both again in `assertTeamPermission`
([ThreadMessageIntake.ts](../../../apps/server/src/orchestration-v2/ThreadMessageIntake.ts)), as
it does for `thread.delete`. Client commands join `OrchestrationV2Command`, the union
`dispatchCommand` decodes. Server-only ones (`sandbox.runner.attached`, `sandbox.runner.lost`) join
the unexported `OrchestrationV2InternalCommand`, which that decode can't reach.

The pattern for compatibility helpers is
[threadPullRequestCompatibility.ts](../../../packages/client-runtime/src/threadPullRequestCompatibility.ts):
a pure function from capabilities to a mode, tested once.

## 9. Work breakdown

PR-sized. "Parallel" means it can start when its milestone's first PR lands. Numbers are local;
[10](./10-delivery-plan.md) assigns delivery IDs (0.1 here is its 0.11; 0.4 is part of its 1.37).

### M0, the seam

| # | PR | Parallel |
| --- | --- | --- |
| 0.1 | Split `OrchestrationV2RunWorkspacePreparation` from the launch strategy. No new literal | first |
| 0.2 | Moved to M1 1.7 and 1.10: a literal no code reads would be dead until then | n/a |
| 0.3 | Dropped: settings gate Cloud (section 2, rule 3) | n/a |
| 0.4 | Moved to M1 1.6: an export with no importer fails knip | n/a |

### M1, Docker cloud threads

| # | PR | Parallel |
| --- | --- | --- |
| 1.1 | `sandbox.ts`, thread `sandboxId`, shell summary, detail record, `sandbox.updated`, commands (with 04's PR 1) | first |
| 1.2 | `runner.ts` and the `./runner` subpath (03's PR 1) | yes |
| 1.3 | `ServerSettings.sandbox` driver instances, project keys `sandboxAllowed`, `defaultsToCloud` | yes |
| 1.4 | Cloud launch strategy member. MCP `t3_thread_launch`, `isolation: "cloud"`, `orchestrator_capabilities`, evals | after 1.1 |
| 1.5 | `t3 thread start --cloud` | after 1.4 |
| 1.6 | client-runtime presentation, commands, permission atoms | after 1.1 |
| 1.7 | Web: mode picker, drafts, send, sidebar icon | after 1.6 |
| 1.8 | Web: header, status line, banners, thread menu, palette, `chat.newCloud` | after 1.6, parallel with 1.7 |
| 1.9 | Web: Settings → Cloud (Overview; Compute with driver, size and read-only caps; Environment variables), project settings, GitHub App key in Source Control | after 1.3 |
| 1.10 | Mobile: new task, header, sheet actions, list, work log, read-only machines page | after 1.6, parallel with 1.7 to 1.9 |
| 1.11 | `machine-failed` notification kind and routing | yes |
| 1.12 | D1: `TeamMemberGitHub.source`, `team.githubTokenSet` and `team.githubTokenClear` with scope, the App key setting, `github-credential-missing` | yes |
| 1.13 | D1 clients: web member row and push notice; mobile Team row and notice | after 1.12 and 1.6 |
| 1.14 | D6: `sandbox.baseImage` setting, shown in Compute and Overview | after 1.3 |
| 1.15 | D5: read-only caps show team cap and starts per minute, no member cap | after 1.9 |

### M2, lifecycle and the hosted driver

| # | PR | Parallel |
| --- | --- | --- |
| 2.1 | Viewer lease from presence reporting | yes |
| 2.2 | Terminal asleep state and `stoppedBy`, web and mobile | yes |
| 2.3 | Preview "Stopped while asleep" | yes |
| 2.4 | Scheduled tasks: cloud choice, `discardOnSettle`, waiting history, web and mobile | yes |
| 2.5 | Usage `sandboxRows`, web and mobile pages | yes |
| 2.6 | Member env vars and `[secret:NAME]` masking display | yes |
| 2.7 | Editable caps; per-launch size in the strategy and the picker | yes |

### M3, team images

| # | PR | Parallel |
| --- | --- | --- |
| 3.1 | `sandboxImage.ts` and `teamImage.*` RPCs with scopes | first |
| 3.2 | Settings → Cloud → Team image page and build log | after 3.1 |
| 3.3 | MCP `sandboxImage` toolkit and evals | after 3.1, parallel with 3.2 |
| 3.4 | Build pushes and their routing rule | after 3.1 |
| 3.5 | Mobile: active build on the machines page | after 3.1 |
| 3.6 | Provider picker marks OpenCode, Grok and Kiro as cloud-ready | yes |

### M4, access and moving threads

| # | PR | Parallel |
| --- | --- | --- |
| 4.1 | `RemoteOpenTargetKind` `sandbox`; open in editor on web and desktop | first |
| 4.2 | Settings → Cloud → Access: SSH keys and the team switch | parallel with 4.1 |
| 4.3 | Continue in cloud and Continue locally (team server) on every web entry point and MCP | yes |
| 4.4 | Desktop: Continue locally on this computer, bundle read RPC and IPC | after 4.3 |
| 4.5 | Cloud-only mode in settings and `limits.cloud.cloudOnly` | yes |

### M5, BYOC

| # | PR | Parallel |
| --- | --- | --- |
| 5.1 | `aws-ec2`, then `gce` members of the driver settings union | yes |
| 5.2 | `limits.cloud.allowedDrivers`; read-only policy rows on web and mobile | yes |
| 5.3 | Driver health in Overview, including the network path check (09) | yes |

## Open questions

1. **What gates Cloud?** Proposed: `ServerSettings.sandbox`, omitted until a driver is configured.
   Capabilities are fixed at startup, while settings stream as `settingsUpdated`
   (`ServerConfigUpdatedPayload` is unused), so no capability and no `ServerConfig.sandboxCompute`
   summary are needed. Driver health and running machines are read on demand by Settings → Cloud.
2. **Does Continue locally reuse `t3_thread_transfer`?** No. That tool forks and merges context
   between threads. Add `t3_thread_move` in M4. Two meanings under one name would confuse agents.
3. **Should old clients see cloud threads at all?** Yes. They are readable and promptable. Hiding
   them would hide teammates' work.
4. **Should mobile get Continue in cloud?** Not in M4. The team-server path needs no local disk, so
   add it when someone asks.
5. **Should an agent be able to discard a machine?** No. Wake is implicit; discard stays human.

## Conflicts found

None open. The README's decisions and D1 to D6 settle every conflict this doc found, and this doc
follows them.
