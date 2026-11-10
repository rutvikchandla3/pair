# 11 Private cloud threads and sharing

Status: proposal, 2026-11-10 (maintainer's request). Nothing here is built. It follows the shared
decisions in the [plan](./README.md) and reverses one of them: on Pair Cloud, a cloud thread is
private to the member who started it until that member shares it. Line numbers are from `feat/pair`
at `8ddac9f79`; re-read every symbol before editing.

Who can open a cloud thread, how does its owner share it, and where does the server enforce that?
This doc is for the engineers building it and for maintainers reviewing the model. Section 2 is
the UX, sections 3 to 6 are the backend, and section 8 is the pull request list.

## Summary

- A cloud thread is **private by default**. Only its owner sees it, in every client.
- The owner **shares it with named members**, as in Google Docs: open **Share**, pick people, done.
  There is no accept step; the thread appears in each person's **Team** shelf at once. An accept or
  request flow is Later.
- Everyone it is shared with can do what any teammate can do on a thread today: read it, prompt
  it, use its terminal, fork it, and continue it locally.
- The owner can also choose **Everyone on the team**, which is today's behaviour for that thread.
- Sharing covers the **session**: the machine and every thread on it (side chats, subagent threads
  and forks), because they share one disk and one set of credentials.
- The server enforces it on every read and write, including requests that name a path on the
  machine and not a thread. A thread a member cannot open looks, to that member, like one that does
  not exist.
- Local threads, a member's own Mac and team servers that are not Pair Cloud do not change.

## 1. What changes, and why it is not theater

[Product decisions](../decisions.md#members-and-roles) says: "Everyone sees every project and
thread. Private threads would be theater on a shared shell." [01 §"Membership is the trust
boundary"](./01-product.md) repeats it for Pair Cloud: "Private threads stay a non-goal."

That reasoning holds on a server where every member's agent runs as one user on one box. It
stopped holding on Pair Cloud once these landed:

- **Cloud-only confinement (2.22, 2.45).** No agent, terminal or script runs on the server, so a
  member has no shell there and cannot read the database, the checkpoint mirror or other members'
  tokens.
- **One machine per session (M1, and VMs with the gce driver in M5).** A member's agent runs in
  its own machine with that session's credentials only.
- **Brokered credentials (06 §3).** A machine holds its own thread's provider and git credential,
  not the team's.

So on Pair Cloud the only path from one member to another member's thread is Pair itself: "anyone
can prompt any thread". This doc closes that path.

What private means, and what it does not:

| Path to a private thread                                | After this doc                                                                                                                                                                                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Another member, through any Pair client, MCP or the CLI | Closed. Sections 3 to 5                                                                                                                                                                                                           |
| Another member's agent, asked to read it                | Closed by the agent reach rule (section 5)                                                                                                                                                                                        |
| GitHub                                                  | **Open.** A pushed branch, its commits and its pull request are as visible as the repository. Private covers the conversation, the terminal, uncommitted work and checkpoints                                                     |
| Another member's machine, over the network              | Closed only where machines cannot reach each other: Docker under gVisor with the private network block, or VMs behind the kit's firewall (5.12). On a flat network a dev server bound to `0.0.0.0` in one machine answers another |
| Plain Docker (`runc`) on the server's host              | **Open.** A container escape reaches the host and everything on it. Settings → Cloud already warns about plain Docker; the warning gains "Private threads are not isolated from other members on this driver."                    |
| The team's shared provider account                      | **Partly open.** Whatever that provider shows an account's other users (usage, and for some providers session history) is outside Pair. A member's own account avoids it                                                          |
| Someone the owner shared it with                        | Open by design. They can read the credentials on the machine, copy the code, and continue it locally. The Share dialog says so                                                                                                    |
| An admin with a shell on the server's host              | **Open.** The database, logs and mirror are files. Privacy is between members in the product, not from whoever operates the server. Admins get no access in the product (section 3)                                               |

**Membership still decides who may use the server and its accounts. It no longer decides who can
read a cloud thread.** [Section 9](#9-docs-to-rewrite-when-this-lands) lists the text that says
otherwise today.

Not in scope: a Viewer role, per-project permissions, several teams on one server, private
_local_ threads on a team server (the shared-shell argument still applies there), and hiding a
project's existence.

## 2. UX

### Vocabulary

| Term             | Meaning                                                                          |
| ---------------- | -------------------------------------------------------------------------------- |
| Owner            | The member the thread belongs to: who started it, or who it was assigned to      |
| Private          | Only the owner can open it. The default                                          |
| Shared with      | The owner and the members they added                                             |
| Everyone on team | Every active member, now and later. Today's behaviour                            |
| Session          | The machine and every thread on it. Sharing is per session; the UI says "thread" |

### Where sharing shows

- **Thread header.** A **Share** button, to the left of the existing header actions. Beside the
  title, one static chip: nothing while private (the default stays quiet), up to three avatars and
  "+2" when shared with people, or "Team" when shared with everyone. Hover or tap lists the names.
- **Sidebar row.** The owner's row shows a small people glyph when the thread is shared, with the
  names as its tooltip. No animation, no badge counts.
- **Team shelf.** A member's **Team** shelf lists only threads shared with them (by name or through
  Everyone on the team), newest activity first, with the owner's avatar, as today. Its empty state
  reads "Threads teammates share with you show up here."
- **Composer footer on a new cloud thread.** No control. A new thread is private; sharing happens
  after it exists. Proposed: this keeps the launch path unchanged. If overruled, the footer gains a
  "Private" chip that opens the picker before the first message.

### Entry points

All of these open the same dialog, and all are owner-only. For anyone else the item is shown
disabled with "Only the owner can share this thread", the pattern `SANDBOX_OWNER_ONLY_REASON`
already uses (client-runtime `state/sandbox.ts` 60).

- The header's **Share** button.
- The thread menu and the sidebar row's context menu: **Share…**, directly under **Assign to…**
  (`threadActionMenu.logic.ts` 221). **Share with guest** stays its own item (it is a different
  mechanism, needs T3 Connect, and is off on a self-hosted Pair Cloud).
- The command palette: **Share thread**.
- A keybinding command `thread.share`, unbound by default, listed in Settings → Keybindings as
  "Thread: Share…" beside "Thread: Assign to…".
- Mobile: **Share** in the thread's menu, as a sheet with the same rows.
- Not an MCP tool and not a CLI command: see [agents](#agents-cannot-share).

### The Share dialog

```text
┌ Share "Fix flaky checkout test" ─────────────────────────────┐
│                                                              │
│  [ Add people…                                         ] Add │
│                                                              │
│  People with access                                          │
│  (R) Rutvik Chandla (you)                           Owner    │
│  (A) Ada Lovelace                                   Remove   │
│  (G) Grace Hopper                                   Remove   │
│                                                              │
│  General access                                              │
│  [ Only people added                                     ▾ ] │
│                                                              │
│  People you add can prompt this thread and use its terminal. │
│  That reaches the provider sign-in and git token on its      │
│  machine. Sharing also covers its 2 side chats and forks.    │
│                                                              │
│  [ Copy link ]                                       [ Done ]│
└──────────────────────────────────────────────────────────────┘
```

- **Add people** is a multi-select over the server's active members, matched on name and GitHub
  username, without the owner and without people already listed. Enter or **Add** adds every chip.
- **General access** has two values: **Only people added** and **Everyone on `<team name>`**.
  Choosing the second keeps the list and shows "Everyone on `<team name>` can open this thread,
  including people who join later."
- **Changes apply at once**, one command per change, with no Save. The row shows the change
  optimistically and rolls back with the server's message if it is refused. **Done** only closes.
- **Remove** asks nothing for a member who owns no thread on the machine. For one who does: "Ada
  has 2 threads on this machine. She will lose access to them too." with **Remove** and **Cancel**.
- **Copy link** copies the same link **Copy thread** does today. A link grants nothing by itself.
- The trust sentence names the provider only when the session runs on the owner's own account:
  "…reaches your Claude sign-in and git token…".
- On mobile the dialog is a sheet: the same rows, the member picker as a second screen.

### What each person sees

| Event                              | Owner                                                           | The member added or removed                                                                                                                                                   | Everyone else |
| ---------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Owner adds Ada                     | Quiet line in the thread: "You shared this thread with Ada."    | The thread appears in her **Team** shelf, unread. A push: "Rutvik shared "Fix flaky checkout test" with you". The thread's first line for her: "Rutvik shared this with you." | Nothing       |
| Owner removes Ada                  | Quiet line: "You removed Ada."                                  | The row leaves her sidebar. If she has it open: "You no longer have access to this thread." and a **Back to threads** button. No push                                         | Nothing       |
| Owner chooses Everyone             | Quiet line: "You shared this thread with everyone on `<team>`." | It appears in every member's Team shelf, not marked unread, and with no push                                                                                                  | Same          |
| A link to a thread you cannot open | n/a                                                             | "This thread is private, or it no longer exists. Ask its owner to share it with you." The page does not say which, and names nobody                                           | Same          |

A member it is shared with gets today's teammate experience unchanged: **Follow**, **Pin**, the
queue and **Steer now** on someone else's turn, `Message from <name>:` for the agent, forks and
side chats on the same machine, and **Continue locally**, which gives them a copy.

### Assign, remove and archive

- **Assign to…** on a private or shared thread is the owner's, not any member's. The picker lists
  every active member. Assigning to someone without access gives it to them; the previous owner
  stays in **People with access** and can be removed by the new owner.
- **Removing a member from the team** (Settings → Team) must say where their cloud threads go.
  The dialog gains: "Ada owns 4 cloud threads. Give them to: `[member picker]`", or **Delete them
  and their machines**. An admin does this without being able to open the threads.
- A removed or deactivated member loses every share at once, as they lose the server.
- **Archive, settle and delete** keep today's rules among people with access (delete is the
  owner's or an admin's).

### Admins

An admin does not see other members' private threads: not in the sidebar, the Team shelf, search
or the archive. Settings → Cloud still lists every machine, because machines cost money:

- A machine the admin cannot open shows "Private · `<owner>`", its state, size, driver and age, and
  no title, branch or link.
- **Sleep** and **Discard machine** work on it as today ("Only the owner or an admin"). Discard's
  confirmation reads "This deletes `<owner>`'s machine and its uncommitted work. You can't see what
  is on it."

Proposed: no "open as admin". If a team needs it, it is a separate, audited action later.

## 3. The access model

### The session is the unit

Access belongs to the **machine record** (`OrchestrationV2Sandbox`, contracts
`orchestrationV2.ts` 504), not to each thread, for three reasons:

- Every thread on a machine reads and writes one disk and one set of credentials (`docs/user`
  already says a fork of a teammate's cloud thread "can read that teammate's credentials there"),
  so two threads on one machine cannot have different audiences.
- Terminals, files and git requests name a **path** under `/t3-sandbox/<sandboxId>/…`, not a
  thread (`WorkspaceHosts.forPath`, `workspaceHost/WorkspaceHosts.ts` 20). A path gives the machine
  directly; it does not give a thread.
- A thread keeps its `sandboxId` after its machine sleeps, is rebuilt (2.13) or is destroyed, so
  the record outlives the disk and stopped reads stay covered.

### The record

```ts
// packages/contracts/src/orchestrationV2.ts, beside OrchestrationV2Sandbox
export const SandboxAccess = Schema.Struct({
  /** `team`: every active member. `members`: the owner and `memberIds`. */
  audience: Schema.Literals(["members", "team"]),
  /** Besides the owner. Kept when the audience is `team`, so switching back restores it. */
  memberIds: Schema.Array(MemberId),
  updatedBy: Schema.NullOr(MemberId),
  updatedAt: Schema.DateTimeUtc,
});

// on OrchestrationV2Sandbox:
/** Absent on records from before private threads, which read as `team`. */
access: Schema.optionalKey(SandboxAccess),
```

- A machine created after this lands starts as `{ audience: "members", memberIds: [] }`: private.
- A record with no `access` is `team`, so nothing that exists at upgrade is hidden. Its owner can
  make it private in the dialog.
- The list is capped at 50 members (proposed; a larger audience is what `team` is for).
- `OrchestrationV2ThreadShellSandbox` (the summary a thread shell carries, `orchestrationV2.ts` 2321) gains the same optional `access`, so clients draw the chip and the dialog from the shell
  they already have. Older clients drop the key and show nothing; the server still enforces.

### The rule

One pure function, used everywhere:

```ts
// apps/server/src/team/threadAccess.ts
export function sandboxAllows(
  record: { ownerMemberId: MemberId | null; access?: SandboxAccess },
  member: { id: MemberId; active: boolean },
): boolean {
  if (!member.active) return false;
  if (record.access === undefined || record.access.audience === "team") return true;
  return record.ownerMemberId === member.id || record.access.memberIds.includes(member.id);
}
```

- **No role is in the rule.** An admin and the server's owner get no access they were not given.
- **A solo server** has one member, who owns everything, so nothing changes (decision "Solo stays
  T3 Code").
- **A thread with no `sandboxId`** on a cloud-only server is its owner's alone; a thread with no
  owner (written before ownership existed) is everyone's. On any other server the rule is not
  consulted and every member sees every thread, as today.
- **Non-members of the server** (guests, runner tokens, thread-scoped MCP tokens) are not members
  and keep their own, narrower rules: a guest link still reaches exactly its one thread.

### Changing it

- A new client command, `sandbox.access.set { commandId, threadId, sandboxId, audience, memberIds,
  actorId }`, joins `SandboxClientCommand` (`ThreadMessageIntake.ts` 63) and is routed to the
  owner thread's stream by `dispatchSandboxCommand` (113), as wake, sleep and discard are.
- **Only the machine's owner may send it** (`record.ownerMemberId === actorId`). Not an admin: an
  admin who could share a thread with themselves could read it. Proposed; see the questions.
- Intake checks, beside `inactive_owner` (`assertTeamPermission`, 89): every id is an active
  member. The decider (`sandbox/lifecycle/SandboxDecisions.ts`) dedupes, drops the owner, enforces
  the cap, and emits nothing when the result equals the stored value, so a replay is a no-op.
- One event, `sandbox.access-changed { sandboxId, access, added, removed, actorId }`. `added` and
  `removed` are the members who gained or lost access by this change, computed by the decider, so
  no consumer has to diff. Switching to `team` lists nobody in `added`.
- **Ownership.** When the owner thread's owner changes (`thread.owner.set`, and
  `SandboxDecisions.ts` 370 already moves `ownerMemberId`), the previous owner is appended to
  `memberIds` in the same decision. `thread.owner.set` on a machine's owner thread is refused
  unless the actor is the owner, or an admin acting for an owner who is no longer active.
- **A machine handed to another thread** (`sandbox.adopt`, when its owner thread is deleted) keeps
  its `access`; the new owner thread's owner becomes the owner.

### Persistence

The record is `payload_json` (migration 088), so `access` needs no column to be stored. Paged
reads filter in SQL, so the projection gains a lookup, in **migration 097** (the next free number):

- `orchestration_v2_projection_sandboxes.audience TEXT` (NULL reads as `team`);
- `orchestration_v2_projection_sandbox_members (sandbox_id, member_id, PRIMARY KEY (sandbox_id,
  member_id))`, written by `SandboxProjection.ts` in the same transaction as the record.

Live checks do not query. `ThreadAccess` keeps an in-memory index of every machine's owner,
audience and members, loaded once from the projection and updated from the committed event, so a
check on a streamed event is a map lookup. Machines number in the hundreds; the index is a few
kilobytes.

## 4. Where the server enforces it

One service owns the question, and transports stay thin
([Effect services](../../internals/effect-services.md)):

```ts
// apps/server/src/team/ThreadAccess.ts
export class ThreadAccess extends Context.Service<
  ThreadAccess,
  {
    readonly allowsSandbox: (memberId: MemberId, sandboxId: SandboxId) => boolean;
    readonly allowsThread: (
      memberId: MemberId,
      thread: { sandboxId?: SandboxId; ownerId?: MemberId | null },
    ) => boolean;
    /** Fails as a missing thread does, so a refusal does not confirm the thread exists. */
    readonly assertThread: (
      memberId: MemberId,
      threadId: ThreadId,
    ) => Effect.Effect<void, ThreadNotFound>;
    readonly assertPath: (memberId: MemberId, path: string) => Effect.Effect<void, ThreadNotFound>;
    /** One item per committed `sandbox.access-changed`. */
    readonly changes: Stream.Stream<SandboxAccessChange>;
  }
>()("t3/team/ThreadAccess") {}
```

Every surface, and what guards it:

| Surface                                                            | Guard                                                                                                                                                                                                                                                  | Today's code                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Sidebar, Team shelf, archive, older settled pages, thread families | `ThreadViewer` gains `allows(thread)`. `overlayForViewer` drops rows it refuses; the older-settled SQL joins the new table. A null viewer (guests) is unchanged                                                                                        | `MemberThreadView.ts` 23, 73; `ShellStream.ts` 141; `ws.ts` 1171–2307 |
| The live shell stream                                              | Events for a thread the viewer cannot open are dropped where `isOtherMembersShellEvent` drops personal ones. On `changes`: a member in `added` receives `thread.updated` for each of the machine's threads, one in `removed` receives `thread.removed` | `ShellStream.ts` 487; contracts 2510–2543                             |
| One thread's subscription, snapshot and HTTP read                  | `assertThread` before the snapshot. On `removed`, the stream ends with a typed `ThreadAccessRevoked`, which the client turns into "You no longer have access"                                                                                          | `ws.ts` 878, 2334; `orchestration-v2/http.ts` 70–116                  |
| Commands from a member                                             | `assertTeamPermission` requires access for every command that names a thread, and for `thread.create` with a parent (side chat, fork, subagent)                                                                                                        | `ThreadMessageIntake.ts` 89                                           |
| Every other RPC that names a thread, a machine or a path           | One table and one middleware, below                                                                                                                                                                                                                    | `clientRpcPermissions.ts`; `observability/RpcInstrumentation.ts`      |
| Attachments, HTML renders, snapshots, checkpoint diffs over HTTP   | The route resolves its thread and calls `assertThread`                                                                                                                                                                                                 | `attachmentStore.ts`, `htmlRender/`, `checkpointing/`                 |
| Viewing leases (they keep a machine awake)                         | `sandboxViewing` requires access; a removed member's leases are released on `changes`                                                                                                                                                                  | `WS_METHODS.sandboxViewing`                                           |
| Presence ("who is looking at this thread")                         | A viewer is reported only to members who can open that thread                                                                                                                                                                                          | `team/Presence.ts` 120                                                |
| Push and in-app notifications                                      | Recipients are filtered through `allowsThread`; a new "shared with you" push goes to `added`                                                                                                                                                           | `notifications/MemberPushNotifier.ts`                                 |
| Usage                                                              | Per-member totals are unchanged. A per-thread row the reader cannot open reads "Private thread", with no title or id                                                                                                                                   | `team/TeamUsage.ts`                                                   |
| Pull requests                                                      | The pull request is GitHub's and stays listed. Its "linked thread" is omitted for a reader who cannot open the thread                                                                                                                                  | `pullRequest/`                                                        |
| Settings → Cloud (`sandbox.overview`)                              | A machine the admin cannot open is sent without its thread ids, title and branch                                                                                                                                                                       | `sandbox/lifecycle/SandboxOverview.ts`                                |
| Guest links                                                        | Creating one needs access; on a `members` session it needs the owner                                                                                                                                                                                   | `guest/GuestShareService.ts`                                          |
| Continue locally, and a copy of a teammate's thread                | The export is refused without access                                                                                                                                                                                                                   | `cloudMove/`                                                          |
| MCP and agents                                                     | Section 5                                                                                                                                                                                                                                              | `mcp/OrchestratorMcpService.ts` 1035                                  |

### One table for every other RPC

About 225 WebSocket methods exist and many name a thread, a machine or a path. Guarding each
handler by hand is how one gets missed, so the mapping lives in contracts and is checked once:

```ts
// packages/contracts/src/rpcThreadTargets.ts
export type RpcThreadTarget =
  | { readonly threadId: string }
  | { readonly sandboxId: string }
  | { readonly path: string };

/** What each method's input points at. A method absent here names no thread, machine or path. */
export const RPC_THREAD_TARGETS: {
  readonly [M in WsMethod]?: (input: unknown) => ReadonlyArray<RpcThreadTarget>;
} = {/* terminal.open: ({ threadId, cwd }) => [{ threadId }, { path: cwd }], … */};
```

- A server middleware beside `RpcInstrumentation` resolves the targets for a member's session and
  calls `ThreadAccess` before the handler runs. A `path` target matters only under `SANDBOX_ROOT`
  (`sandboxIdFromPath`, `WorkspaceHost.ts`); any other path is the server's own and is already
  confined on a cloud-only server (2.45).
- **An exhaustiveness test** walks every RPC's payload schema and fails when a method has a field
  named `threadId`, `sandboxId`, `cwd`, `path`, `worktreePath` or `root` and is neither in the
  table nor in a short `RPC_THREAD_TARGET_EXEMPT` list, each entry with its reason. A new RPC
  cannot ship unguarded by forgetting.
- The check costs one map lookup per target and nothing on a solo server or a server that is not
  cloud-only, where the middleware is not installed.

### Refusals

A refusal uses the error and the text a missing thread already produces. The log line carries the
real reason (`access_denied`, the member and the machine) for operators. No response, title, count
or timing path distinguishes "private" from "gone" for a member; the lookup happens before any
work that scales with the thread.

## 5. Agents

An agent acts with a thread's credentials and is steered by whoever prompts it. Without a rule, a
member Ada who was shared thread A could ask A's agent to read the owner's private thread B.

- **Reach rule.** An agent's thread tools (`t3_thread_list`, read, send, and the rest in
  `OrchestratorMcpService`) reach a target session only when **every member who can open the
  agent's own session can open the target**. So an agent in a private thread reaches its owner's
  other private threads; once that thread is shared with Ada, it reaches only what Ada can also
  open. `team` sessions reach `team` sessions.
- **Children.** A thread an agent starts (a delegated cloud task, a subagent on a new machine)
  copies its parent session's `access` and owner at creation.
- **A member's own client or agent link** (a Mac agent acting through the Pair Cloud link, 3.19)
  acts as that member and gets that member's access.
- <a id="agents-cannot-share"></a>**Agents cannot share.** There is no MCP tool and no CLI command
  that changes access. A prompt injection must not be able to widen who reads a thread. `t3` on the
  server's host keeps acting as the server's owner with the host's access, which section 1 already
  counts as open.
- **Scheduled and webhook runs** belong to the task's creator and start private. A task gains the
  same `access` value, "Share runs with", applied to each run's machine at creation. Existing tasks
  read as `team`.

## 6. Clients and contracts

- **Contracts.** `SandboxAccess`; `access` on the machine record and on the shell's machine
  summary; the `sandbox.access.set` command and `sandbox.access-changed` event; `ThreadAccessRevoked`
  on the thread subscription's error union; `RPC_THREAD_TARGETS`. All additive. No new auth scope:
  the command needs `orchestration:operate`, and ownership, not a scope, limits who may send it
  (as `teamProviderAccountsMutate` notes in `clientRpcPermissions.ts` 101).
- **client-runtime.** `sandboxAccessSummary(shell, members, me)` returns the chip and tooltip;
  `shareThreadCommand` through `createEnvironmentRpcCommand` with a `permissionAtom` that is false
  for anyone but the owner. Web and mobile share both.
- **Web.** `ShareThreadDialog` and its `.logic.ts` (member filtering, optimistic rows); the header
  button and chip; the sidebar glyph; the menu, palette and keybinding entries; the lost-access and
  no-access states; Settings → Cloud's private machine rows; Settings → Team's removal step.
- **Desktop.** Nothing of its own: it wraps web.
- **Mobile.** The share sheet, the chip, the two states. The Team shelf needs no change: it lists
  what the server sends.
- **Older clients** keep working. They cannot share, and they see only what they may.
- **Connection modes.** Access is the destination server's. A client connected to Pair Cloud
  directly, over Tailscale, or through a relay gets the same answers; nothing is decided on the
  client.

## 7. Verification

Tests sit at the lowest layer that fails without the change (AGENTS.md):

- `threadAccess.test.ts`: the rule's table (owner, listed, unlisted, `team`, no record, inactive,
  admin, solo).
- `SandboxDecisions.test.ts`: set by the owner; refused for anyone else, for an inactive member and
  over the cap; a replay emits nothing; an owner change keeps the previous owner; adopt keeps
  access.
- `ShellStream.test.ts` and `MemberThreadView.test.ts`: a refused viewer gets no row and no event;
  `added` produces `thread.updated`, `removed` produces `thread.removed`; a guest viewer is
  unchanged.
- `ThreadMessageIntake.test.ts`: each command kind from a member without access is refused as a
  missing thread.
- `rpcThreadTargets.test.ts`: the exhaustiveness walk.
- `OrchestratorMcpService.test.ts`: the reach rule, in both directions.
- Web and mobile logic tests for the dialog's list and the chip. No UI test for static controls.

The integrated pass, on Pair Cloud with members A (owner), B and an admin C:

1. A starts a cloud thread. B and C do not see it in the sidebar, Team shelf, search, archive or
   command palette; its link shows the private-or-gone page; B's `t3_thread_list` omits it.
2. A shares it with B. It appears in B's Team shelf unread and B gets one push. B prompts it, opens
   a terminal and a side chat. C still sees nothing.
3. From B's session, every RPC in `RPC_THREAD_TARGETS` is tried against a second private thread of
   A's, by thread id and by `/t3-sandbox/<id>` path. Each answers as a missing thread.
4. A removes B while B has the thread and a terminal open. B's view changes to the lost-access
   state within a second, the terminal closes, and the machine's viewing lease from B is gone.
5. A chooses Everyone. B and C see it. A chooses Only people added; C loses it and B keeps it.
6. In B's shared thread, B asks the agent to read A's other private thread. It is refused.
7. C opens Settings → Cloud: the private machine shows owner and state only; **Discard machine**
   works.
8. C removes A from the team and gives A's threads to B. B now owns them.
9. A thread that existed before the upgrade is still visible to everyone and reads "Team".

## 8. Pull request plan

Row numbers continue the delivery plan as **M6**. Full PR specs are written from the code when
the row is picked up, as for every other milestone.

| #   | Title                                                                                                                                          | Size     | Needs    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------- |
| 6.1 | `feat(contracts,server): record who can open a cloud session` (record, command, event, decider, migration 097, `ThreadAccess` and its index)   | Critical | M1, 1.17 |
| 6.2 | `feat(server): hide cloud threads from members without access` (viewer, shell stream and its transitions, thread reads, HTTP, paged SQL)       | Critical | 6.1      |
| 6.3 | `feat(contracts,server): guard every thread, machine and path RPC` (the target table, the middleware, command intake, the exhaustiveness test) | Critical | 6.1      |
| 6.4 | `feat(server): keep private threads out of agents, push, presence, usage and Settings` (the reach rule and section 4's remaining rows)         | Critical | 6.2, 6.3 |
| 6.5 | `feat(web,client-runtime): share a cloud thread with teammates` (the dialog, chip, glyph, entry points, lost-access and no-access states)      | Critical | 6.1      |
| 6.6 | `feat(mobile): share a cloud thread from the phone`                                                                                            | Small    | 6.5      |
| 6.7 | `feat(server,web): hand over a member's cloud threads, and owner-only Assign`                                                                  | Small    | 6.2      |
| 6.8 | `feat(server,web): share a scheduled task's runs`                                                                                              | Small    | 6.4      |
| 6.9 | `docs: cloud threads are private until shared` (section 9, and the plain-Docker warning)                                                       | Small    | 6.5      |

- 6.1 lands first; 6.2 and 6.3 touch different files and run together; 6.4 follows both. 6.5 needs
  only 6.1's contracts and can run beside the server rows.
- **One release carries all of it.** 6.1 alone makes new machines `members` while nothing enforces
  it, which is harmless (everyone still sees everything) but must not ship without 6.2 to 6.4.
- 6.2, 6.3 and 6.4 are the security rows: Opus, high effort, and the integrated pass's step 3 is
  their gate.

## 9. Docs to rewrite when this lands

Rewrite, do not append ([documentation rules](../../../AGENTS.md#documentation)):

- [decisions.md](../decisions.md): "Membership is the trust boundary" (on Pair Cloud, "anyone can
  prompt any thread") and "Everyone sees every project and thread. Private threads would be
  theater on a shared shell." The second stays true for local threads on a team server only.
- [01 Product](./01-product.md): the amended trust text, "It is not isolation between members",
  "Private threads stay a non-goal", and the not-building list.
- [06 Credentials and security](./06-credentials-and-security.md) §1 and §11, and
  [09 BYOC](./09-byoc.md) §9's **Access** row: "everyone sees and can prompt every thread".
- [README](./README.md): "every teammate can open the session and prompt it", and the Documents
  table (this doc's row is already there).
- The invite dialog on Pair Cloud: "Members can prompt any thread, which reaches its provider
  sign-in and git token." becomes "Members can start cloud threads on this server's machines and
  provider accounts. They see a teammate's thread only when it is shared with them."
- `docs/user/team.md` (**Share a thread**, **Your threads and the Team shelf**),
  `docs/user/cloud.md` (the trust paragraph, forks of a teammate's thread) and
  `docs/user/pair-cloud.md` (**Invite the team**): one section, "Who can open a cloud thread", with
  how to share and what private does not cover (section 1's table, in user terms).

## Open questions

Each has the answer this doc builds on; a reviewer can overrule it in the named row.

- **Can a member it is shared with add more people?** No: only the owner (6.1). Google Docs lets
  editors share by default, and teams turn it off. If overruled, the command's check becomes "has
  access" and the dialog's list shows who added whom.
- **Do admins get access?** No, and no "open as admin" (6.1, 6.4). They keep cost control:
  Sleep, Discard, and handing over a removed member's threads.
- **Is there a team-wide default?** No setting. New threads are private; **Everyone on the team**
  is per thread. If a team wants the old default, it is one key, `sandbox.sharing.default`, and a
  managed-policy lock, added when asked for.
- **Are existing threads hidden at upgrade?** No. They read as `team` until their owner changes
  them (6.1).
- **A share picker in the composer before the first message?** No (6.5).
- **What does a removed member's own thread on the machine become?** It stays on the machine, and
  they lose it. The dialog warns the owner first (6.5).
- **Does a no-access link name the owner, or offer "Request access"?** Neither. That is the accept
  and request flow, Later.
- **A read-only role?** Later. The record leaves room: a `viewerIds` list beside `memberIds`.
- **Local threads on a team server?** Unchanged. Their agents share one shell, and that is where
  "private threads would be theater" still applies.
