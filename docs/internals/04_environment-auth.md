# Environment authentication

The environment issues its own sessions and enforces their capabilities. Cloud identity and relay
credentials belong to a separate trust boundary, described in [T3 Connect](./06_t3-connect.md). A relay
token is never an environment login. See [SECURITY.md](../../SECURITY.md) for the overall threat
model.

## Scoped sessions and delegation

- **Narrowing only.** Pairing delegates a set of scopes. Exchanging a bootstrap credential can
  narrow a grant, never widen it. A pairing link never delegates a scope its creator lacks. Client labels and device metadata have no authorization role.
- **Why the default grant includes management scopes.** `terminal:operate` and
  `orchestration:operate` already grant OS-user execution (which can invoke `t3 auth session issue`),
  so withholding access or relay management from the default grant would not be a real boundary.
  Narrower clients receive explicit scopes.
- **No recoverable secrets in read models.** Only the creation response returns a raw pairing
  credential; access listings expose metadata only.
- **DPoP binding.** Browser cookies, bearer tokens, and DPoP tokens share the scoped session model.
  DPoP binds tokens to a client proof key; an invalid proof must fail rather than fall back to
  bearer auth. Plain paired DPoP sessions renew in place so live sockets and Sharing & access rows
  stay stable; T3 Connect, CLI, and desktop sessions never self-renew so revoking/unlinking cuts
  them off.
- **WebSocket tickets and per-RPC authorization.** Bearer and DPoP clients mint short-lived tickets
  over authenticated HTTP so long-lived tokens never appear in socket URLs. DPoP RPC tickets stay
  proof-key bound at upgrade. A successful handshake grants no extra authority: every RPC declares
  and checks its required scope in [`RpcAuthorization.ts`](../../apps/server/src/auth/RpcAuthorization.ts).
- **Backward-compatible scope evolution.** Token exchange intersects requested scopes with the
  pairing grant, dropping retired/unknown names and failing before consuming a link if none remain.
  Stored grants are never expanded when scopes split. Auth responses preserve legacy `scopes`
  alongside exact `permissions` so older clients and servers stay compatible.

## Every session belongs to a member

Sessions and pairing links carry a `member_id`; the subject keeps describing how the client signed
in. Existing rows migrate to the owner, and desktop bootstrap grants issue owner sessions. A row
with no member can only come from an older binary after a rollback: it resolves to the owner while
the environment has one active member and is refused once it is a team. The owner cannot be removed
or demoted, so an environment always keeps an admin.

- **Roles are scope bundles** defined in [team.ts](../../packages/contracts/src/team.ts). Admins hold
  every standard scope. Members lose settings, provider, access, relay and maintenance management
  but keep `terminal:operate` and `orchestration:operate`. By the argument above, roles guard
  against mistakes, not against a hostile teammate.
- **Provider accounts are the one exception to `providers:manage`.** A member creates, renames and
  removes only their own instances through `team.providerAccounts.mutate`
  ([MemberProviderAccounts](../../apps/server/src/team/MemberProviderAccounts.ts)), which picks the
  id, home and environment so a member cannot aim one at the team's login or another binary. The
  `providerAuth*` RPCs admit a member with `orchestration:operate` when the instance's
  `ownerMemberId` is theirs, and the client's `permissionAtom` stays scope-based. The owner field is
  routing, not secrecy: anyone with a terminal can read the login.
- **Any member can add a device.** The pairing-credential endpoint needs only `access:read`, binds
  the link to the caller's member, and defaults to the caller's scopes. Without `access:write`, the
  access snapshot and stream show only the caller's own clients and links, and revoking someone
  else's is refused. "Revoke others" is member-scoped even for admins.
- **Role changes apply to existing sessions** ([TeamMembers](../../apps/server/src/team/TeamMembers.ts)).
  Demotion intersects each session with the member bundle and revokes unconsumed links, which still
  carry admin scopes. Promotion widens only sessions that hold the full member bundle, so a
  deliberately narrow one stays narrow. `awaitInvalidation` closes a socket whose stored scopes
  changed and compares stored scopes, never the narrower set a cloud-only server authenticates a
  member with (`effectiveScopes`), or every member's socket would close on upgrade. Removal revokes
  the member's sessions and unconsumed links, and authentication independently rejects a removed
  member.
- **Members live in an in-memory snapshot** ([TeamState](../../apps/server/src/team/TeamState.ts));
  only the server's own writes close sockets and update its Team stream. So `t3 member` goes through
  the `team.*` RPCs of a running server and writes the database itself only when none answers
  ([member.ts](../../apps/server/src/cli/member.ts)). The server rereads members when it meets an
  unknown id or lists the team. A removal written while it was unreachable is enforced through the
  revoked rows; open sockets last until they reconnect.
- **Commands carry an `actorId` only from the session that sent them** (`withActor` in
  [ThreadManagementService](../../apps/server/src/orchestration-v2/ThreadManagementService.ts));
  agent, MCP and scheduled commands carry none and never count as human authors. The orchestrator
  decides at dispatch whether a user message names its sender to the provider: only once a thread
  has two or more distinct human authors. The stored text never changes; the name is added where
  provider input is built ([SenderLabel](../../apps/server/src/orchestration-v2/SenderLabel.ts)),
  so solo threads send byte-identical input and keep provider prompt caches warm.

## Non-standard principals

- **Guest links are not sessions.** [GuestShareService](../../apps/server/src/guest/GuestShareService.ts)
  issues HMAC tokens bound to one share in the thread projection—never `SessionStore` rows—so no
  RPC, WebSocket, or MCP route can accept one. Closing, replacing, or archiving the share revokes
  every token. Guest routes also require T3 Connect to still serve the link's hostname (never rely
  on the request `Host` header alone).
- **MCP clients (`mcp-client`) are a separate audience.** Outside agents authenticate on `/mcp` via
  PKCE OAuth ([McpOAuth](../../apps/server/src/auth/McpOAuth.ts)), with stateless client
  registration so unauthenticated callers cannot grow server state. Users grant read-only access or
  a runtime-mode ceiling rather than raw scopes. Approval spends a one-time pairing code or uses a
  browser session with `access:read`, never granting a scope that session lacks, and the client
  session belongs to the approving member (the code's member, or the browser session's). API tokens
  are `mcp-client` sessions a member issues for themselves; they reach only `/mcp`. Every non-`/mcp`
  HTTP and WebSocket route rejects `mcp-client` sessions (except the read-only thread relay and
  client-pairing routes restricted to [peer links](./05_remote.md#peer-links), and, on a cloud-only
  server, the cloud-move routes in [CloudMoveHttp.ts](../../apps/server/src/cloudMove/CloudMoveHttp.ts),
  which accept a linked environment's session with operate access and take bytes, not commands). Every MCP tool must statically declare its access level in
  [`McpToolAccess.ts`](../../apps/server/src/mcp/McpToolAccess.ts), and thread-only tools must still
  refuse outside callers in handlers—hiding from tool listings is only discovery.
- **Pair Builder's proxy vouches for its users.** In
  [Pair Builder host mode](./01_architecture.md#pair-builder-host-mode) the proxy strips cookies and
  `Authorization` and adds its own ingress token and an `X-Pair-User` identity to every request.
  [EnvironmentAuth](../../apps/server/src/auth/EnvironmentAuth.ts) trusts the identity only beside
  the token (compared in constant time) and treats a missing or malformed one as no identity, so the
  token alone opens no session; only `/api/host/sessions` accepts it bare. The person is the member
  bound to their Builder user id ([PairBuilderMembers](../../apps/server/src/team/PairBuilderMembers.ts)),
  added as a `member` on first sight; a removed member keeps the binding, so removal is what locks a
  Builder user out. The token rides along with every browser request, so it is as ambient as a cookie
  and gets the same origin check: the proxy must pass `Origin` and `X-Forwarded-Host` through. Each
  member has one persisted `pair-builder-ingress` session that never expires; it carries no
  credential and exists so `/ws` can track and close sockets and role changes reach them. Revoking
  it only closes those sockets; the next proxied request opens a new one.
- **Peer-link client pairing.** Only a full-access peer link may mint a one-time client pairing on
  the linked environment (since full-access agents can already run `t3 auth pairing create`). The
  linked side enforces this itself, and the operation stays a human-triggered RPC/HTTP route rather
  than an MCP tool.

### Reusable dev credential

Web development servers can accept a fixed `T3CODE_DEV_AUTH_TOKEN` across worktrees and ports on one
hostname (see the [development runbook](../operations/00_development.md#reusable-dev-credential)). It
grants administrative access and is ignored by desktop and non-development servers.

Each environment hashes the value into its own database record and keeps independent SQLite state,
signing keys, and revocation state. Normal credentials always take precedence: a rejected normal
credential never falls back to the reusable dev credential.

## The environment is the filesystem boundary

Projects are organizational boundaries, not filesystem sandboxes. `filesystem:read` permits reading
any file the server's OS user can read (for example, artifacts an agent writes in a temp directory);
relative paths and writes remain constrained by
[`WorkspaceFileSystem.ts`](../../apps/server/src/workspace/WorkspaceFileSystem.ts).

Signed asset URLs are bearer credentials for a single canonical file, rechecked by device/inode
identity on serve ([`AssetAccess.ts`](../../apps/server/src/assets/AssetAccess.ts)). They never
grant access to sibling files, and because `filesystem:read` is checked only at mint time, an issued
URL remains valid until it expires even if the session or grant is revoked.
