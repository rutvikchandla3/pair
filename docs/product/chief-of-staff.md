# Chief of staff

Status: built, except on Pair Cloud (see [§8](#8-pair-cloud)). This is the maintainer's map of the
feature. The agent, voice and memory rules are in the code and in
[Spaces agent §6](./spaces-agent.md#6-tools-and-permissions); this doc is the one page
that ties them together and records the Pair Cloud decision.

Chief of staff is one persistent agent per member: a **home thread** the user talks to in chat, a
**voice relay** that lets the same thread speak through Codex realtime, and durable **memory** and
**audit** on the server. It runs inside the local server. It is not a provider, a Space agent or a
cloud thread; agent work it starts is ordinary work.

## Summary

- **One home thread per member.** `ensureHome` creates a project rooted at a server folder and a
  thread with `workspaceStrategy: { type: "root" }`, then records the thread in `threads.json`
  under `home:<memberId>`. (§2)
- **The persona is regenerated, memory is rendered.** Every ensure rewrites `AGENTS.md`, and every
  memory read/write rewrites `MEMORY.md`, so both are current without a migration. (§2, §4)
- **Voice is a relay, not the brain.** A `codex app-server` child on the server host opens a
  read-only backing thread; it forwards the user's words to the home thread through the same MCP
  tools and speaks back the home thread's `Summary:` line. (§3)
- **Memory is labelled, capped blocks.** Seven blocks with per-block character limits, a JSON file
  and a JSONL history per member, plus the `MEMORY.md` mirror. (§4)
- **Every tool call is audited.** Secrets are redacted, arguments cut to 1000 characters, and the
  log rotates at 5 MiB. (§5)
- **Proactive digests and confirmations are opt-in additions.** P3 wakes a home thread when the
  user's threads change; P4b gates risky tools behind a card. (§6, §7)
- **Not on Pair Cloud yet.** A cloud-only server refuses the home thread with a clear error; the
  design for running it there is in §8.

## 1. What the user sees

- **Chat.** A button and command-palette entry open the home thread (`WS_METHODS.chiefOfStaffOpenHome`,
  `packages/contracts/src/rpc.ts`). It is a normal thread: one project titled "Chief of staff", owned
  by the member.
- **Voice.** `chiefOfStaff.start` opens a realtime session, streams state and transcripts to the
  client, and `chiefOfStaff.listVoices` lists Codex voices. Only Codex speaks realtime
  (`supportsChiefOfStaffVoice`, `packages/contracts/src/chiefOfStaff.ts`).

## 2. The home thread

`apps/server/src/chiefOfStaff/ChiefOfStaffHome.ts` owns it.

- **Project and folder.** `ensureHome` bootstraps a project whose `workspaceRoot` is
  `<stateDir>/chief-of-staff/home/<memberId>` and launches the thread with
  `workspaceStrategy: { type: "root" }`, `createdBy: "system"`, `creationSource: "server"`, owner
  set to the member. One per member, never two: a per-member `Semaphore` serializes the check.
- **Persona.** `writePersona` writes `AGENTS.md` from `homeInstructions()`
  (`chiefOfStaffProtocol.ts`) and `CLAUDE.md` containing `@AGENTS.md`. The persona says it is an
  owner-level operator with a shell, the `t3` CLI and the thread-scoped `t3_*` tools; the file is
  rewritten on every ensure, so a prompt change reaches an existing home.
- **Model.** `resolveModelSelection` reads `chiefOfStaff.homeProviderInstanceId` and `homeModel`,
  falling back to the server's default for new threads, then the instance's default model.
- **Runtime mode.** The configured `chiefOfStaff.toolAccess`, capped by the caller's own scopes
  (`effectiveToolAccess`). `read-only` becomes `approval-required`, because runtime modes have no
  read-only level.
- **A stored thread is reused.** A live shell is returned; an archived one is unarchived. A deleted
  or missing one is recreated. The audit hook and MCP tools read the same map
  (`homeThreads.ts`, a 5-second cached `threads.json` reader that `ensureHome` invalidates).

**`threads.json` contract.** One JSON object keyed by string, values are thread ids:

| Key                       | Written by                     | Meaning                            |
| ------------------------- | ------------------------------ | ---------------------------------- |
| `home:<memberId>`         | `ChiefOfStaffHome.ensureHome`  | The member's home thread.          |
| `<memberId>:<instanceId>` | `ChiefOfStaffVoice.openThread` | The Codex realtime backing thread. |

Malformed or non-string entries are ignored (`parseHomeThreads`). Only `home:*` keys mark a thread
as a home thread for tool attribution.

## 3. The voice relay

`apps/server/src/chiefOfStaff/ChiefOfStaffVoice.ts` and `ChiefOfStaffHost.ts`.

- **The brain is the home thread.** `start` calls `ensureHome` first, then issues an MCP credential
  labelled `Chief of staff` (`caller.ts`) and spawns `codex app-server` on the **server host**
  (`ChiefOfStaffHost.openAppServer`). The child gets `T3CODE_HOME`/`CODEX_HOME` so its shell finds
  this server.
- **The backing thread only relays.** `backingThreadParams` starts it `sandbox: "read-only"`,
  `approvalPolicy: "never"`, with the `t3-code` MCP server and `relayInstructions(homeThreadId)`. It
  calls `t3_thread_send`/`t3_thread_wait`/`t3_thread_read` and speaks the final `Summary:` line.
- **Realtime is raw.** `thread/realtime/start` uses WebRTC v3 audio; requests the generated client
  lacks go through `client.raw` (`chiefOfStaffProtocol.ts`). Notifications become client state and
  transcript events; server status is pushed when thread status changes.
- **Sessions are per member.** Replacing a session closes the old one; a session with no subscriber
  for 10 seconds closes, bounding paid realtime time. `openAppServer` returns a clear
  `ChiefOfStaffError` when the Codex instance is missing, disabled, unauthenticated, or not Codex.

## 4. Memory

`apps/server/src/chiefOfStaff/ChiefOfStaffMemory.ts`.

- **Seven blocks**, with character caps: `profile`, `preferences`, `standing_orders`, `goals`,
  `commitments`, `projects`, `notes` (1500–3000 each). `cos_memory_update` supports `set`, `append`
  and `replace` (replace needs a unique `old_text`).
- **Files.** `<stateDir>/chief-of-staff/memory/<memberId>.json` (blocks) and
  `<memberId>.history.jsonl` (one line per change with before/after and actor). Writes are atomic
  and serialized per member.
- **`MEMORY.md` mirror.** Every read and write renders the blocks to
  `<stateDir>/chief-of-staff/home/<memberId>/MEMORY.md`. Direct edits are overwritten; the tools are
  the only writers.
- **Tools.** `cos_memory_read`, `cos_memory_update`, `cos_memory_history`, enabled only for a
  Chief of staff caller and only to its own member.

## 5. Audit

`apps/server/src/chiefOfStaff/ChiefOfStaffAudit.ts`.

- **One JSONL per server:** `<stateDir>/chief-of-staff/audit.jsonl`, rotated to `audit.1.jsonl` past
  5 MiB. Each entry records `via` (`voice` or `home-thread`), the member and thread, the tool, the
  arguments with secret-looking keys redacted and cut to 1000 characters, outcome, error code and
  duration.
- **Reads:** `cos_audit_read` (newest first, optional `tool` filter, at most 200 entries). Writes are
  fire-and-forget; a failure is logged and never fails the tool call.
- **Who is a caller:** `caller.ts` matches the `Chief of staff` MCP client label, or a thread id in
  the `home:*` map. Everything else is an ordinary caller.

## 6. Triggers (P3)

`ChiefOfStaffTriggers.ts` (branch `t3/chief-of-staff-p3`). When `chiefOfStaff.proactive` is on, the
server watches committed thread changes (`ChiefOfStaffHost.statusChanges`), debounces bursts by 5
seconds, and wakes the relevant member's home thread with a digest of transitions: a thread finished,
failed or was interrupted, or now needs an approval or an answer (`diffTransitions`). Digests are
rate-limited (at least a minute apart, at most 20 an hour) and respect thread access. The home thread
receives the digest as a developer line; it is not a new thread.

## 7. Confirmation (P4b)

`ChiefOfStaffConfirmation.ts` and `policy.ts` (branch `t3/chief-of-staff-p4b`). Before the server runs
a risky tool for Chief of staff, it posts the existing secret-request card in the home thread and
waits up to 10 minutes: `saved` allows, `declined` denies, no answer times out. `isRiskyCall` covers
the member's `confirmTools` list (default `DEFAULT_CONFIRM_TOOLS`) plus tools that are risky on their
arguments alone, such as `t3_thread_organize` with `action: "archive"`. The card's text is a
secret-free one-line summary of the arguments.

## 8. Pair Cloud

**Current behaviour (P5).** A Pair Cloud server is started `--cloud-only` (`ServerConfig.cloudOnly`).
Every agent there runs in a machine that checks out a repository, and the server's own filesystem is
not an agent's to read; the one server-side exception is the in-process `spaceAgent`, which has no
shell, files or subprocess (`spaces-agent.md` §14.6, `ProviderSessionManager.ts`). Chief of staff's
home thread is the opposite: a repo-less `root` folder on the server, and a Codex persona that may
"use your shell, edit files" (`homeInstructions`). So `ensureHome` refuses before it writes anything:

```text
Chief of staff isn't available on this Pair Cloud server yet: its persona and memory live in a
folder on the server it runs on. Use the Pair app on your Mac for now.
```

The refusal is a `ChiefOfStaffError` (`reason: "start-failed"`), so chat and voice both surface the
message. The server-side services that need no thread — memory blocks, the `MEMORY.md` render, the
audit log and `cos_*` tools — are plain filesystem state under `stateDir` and do work on a cloud
server; there is simply no home thread to call them.

**Why not the alternatives.**

- **Run the home thread on the cloud server (a `root` exemption).** Rejected: the persona needs a
  real shell, and a shell on the shared server can read every member's memory, transcripts and
  credentials. The cloud-only rule exists for exactly that.
- **Run the home thread on a cloud machine.** A cloud launch requires a project whose `origin` is a
  `https://github.com` repository (`ThreadLaunchService.launch` refuses `local-launch` on cloud-only;
  `CloudPreparation.cloneTarget` fails `no-origin` otherwise), and scratch projects are refused on
  cloud-only (`ManagedProjectFolders`). Chief of staff has no repository, so this needs a repo-less
  cloud workspace or a dedicated machine — a core change, not this feature's.

**A future that fits the Cloud model.**

- **If the home thread moves to a machine:** persona and memory cannot live in a local folder. Put
  `homeInstructions()` plus the rendered `MEMORY.md` at the head of the first message, keep the
  memory ledgers and `cos_memory_read` on the server (they already are), and let the home thread
  fetch updates through the tools. The folder stays for local servers.
- **If it stays server-side:** it must become an in-process adapter with no shell, files or
  subprocess, like `spaceAgent`. Voice then relays to that thread. This is the smaller security
  surface but a new adapter.

Until one of those lands, the guard in `ensureHome` is the contract: a cloud-only server says so
clearly instead of half-creating a project.

## Settings fields

`ChiefOfStaffSettings` (`packages/contracts/src/chiefOfStaff.ts`), all defaulted:

| Field                    | Meaning                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| `enabled`                | Master switch; off makes voice refuse with `disabled`.              |
| `providerInstanceId`     | Codex instance for the voice child; empty uses Codex's default.     |
| `voice`                  | Codex voice id; empty uses the provider default.                    |
| `model`                  | Voice backing-thread model; empty uses the text-generation default. |
| `homeProviderInstanceId` | The home thread's provider; empty uses the server default.          |
| `homeModel`              | The home thread's model; empty uses the instance's default.         |
| `toolAccess`             | Access lent to the MCP credential, capped by the caller's scopes.   |
| `realtimeBaseUrl`        | Overrides the realtime endpoint; empty uses Codex's.                |
| `proactive` _(P3)_       | Wake the home thread with digests of thread changes.                |
| `confirmTools` _(P4b)_   | Tools that need an approval card before the server runs them.       |

## Folder layout

Under `<stateDir>` (normally `<baseDir>/userdata`):

```text
chief-of-staff/
  threads.json                    # home:<memberId> and <memberId>:<instanceId> thread ids
  audit.jsonl, audit.1.jsonl      # tool-call log, rotated at 5 MiB
  memory/
    <memberId>.json               # the seven blocks
    <memberId>.history.jsonl      # one line per change
  home/
    <memberId>/AGENTS.md          # persona, regenerated on ensure
    <memberId>/CLAUDE.md          # "@AGENTS.md"
    <memberId>/MEMORY.md          # rendered from the blocks
  workspace/                      # cwd for the read-only voice backing thread
```

## Sources

- **Code:** `apps/server/src/chiefOfStaff/` (`ChiefOfStaffHome.ts`, `ChiefOfStaffHost.ts`,
  `ChiefOfStaffVoice.ts`, `ChiefOfStaffMemory.ts`, `ChiefOfStaffAudit.ts`, `chiefOfStaffProtocol.ts`,
  `caller.ts`, `homeThreads.ts`); `apps/server/src/mcp/toolkits/chiefOfStaffMemory/` and
  `chiefOfStaffAudit/`; `packages/contracts/src/chiefOfStaff.ts`.
- **Design:** [Spaces agent](./spaces-agent.md), [Cloud plan](./cloud/README.md),
  [Private cloud threads](./cloud/11-private-threads.md).
- **Cloud guards:** `apps/server/src/orchestration-v2/ThreadLaunchService.ts` (`local-launch`),
  `apps/server/src/sandbox/lifecycle/CloudPreparation.ts` (`no-origin`),
  `apps/server/src/project/ManagedProjectFolders.ts` (scratch refused).
