# Spaces: handoff prompts

These are the prompts for the agents that build Spaces and `@pair` end to end. Give each one to a
fresh agent session in this repository.

The split follows dependencies:

1. **Core** comes first. It defines the contracts that everything else imports.
2. **@pair** and **Web and desktop** can start together once Core has merged into `feat/space`.
3. **Mobile** starts once Web has put the shared client logic in `packages/client-runtime`.

Each agent works on its own branch cut from `feat/space` and opens a PR back into `feat/space`.

---

## 1. Core: contracts and server

```text
You are building the server and contract foundation for Spaces in Pair (this repo, a fork of T3 Code).

Start: cut `feat/space-core` from `feat/space` in a new worktree next to this checkout, and run `vp i` if setup didn't. Read AGENTS.md first and follow it: never touch ~/.t3/userdata, no repo-wide checks, and real agent turns use the Replay (dev) provider.

What to build. The source of truth:
- docs/product/spaces.md: the product.
- docs/product/spaces-prototype/README.md and its screens: the behaviour every state must support.
- docs/product/spaces-agent.md: read §3 (space.post and the trigger rules), §5 (the notes schema) and §7 (commands, events, projections). This lets you leave room for @pair without building it.
- docs/product/decisions.md: threads, notifications and provider accounts.
- docs/internals/overview.md and docs/internals/effect-services.md.

Scope (Spaces M1, without @pair):
1. Contracts in packages/contracts, all additive:
   - A Space: name, owner, members with joinedAt, project, Brief, archivedAt, and who pays for @pair.
   - Join requests.
   - A room thread kind.
   - A thread's spaceId.
   - space.post with mention tokens (member ids, and `pair`).
   - Space commands and events:
     - create and update
     - archive and unarchive
     - member add and remove, with Undo
     - transfer ownership and leave
     - request to join and cancel the request
   Put each new client RPC in CLIENT_GUARDED_RPC_SCOPES with createEnvironmentRpcCommand. Extend the permission behaviour tests.
2. Orchestration in apps/server/src/orchestration-v2:
   - Decide the events in the Orchestrator, which stays pure and does no I/O.
   - Project the space, its members, its room timeline (posts, quote-replies, system lines) and its tasks.
   - Enforce the "Who can do what" table in spaces.md at intake, server-side.
   - An archived space rejects posts and new tasks. Running tasks keep running.
3. Tasks in a space:
   - New task creates a cloud thread with spaceId, an owner, a description, a model and a base (a branch, or continue a PR).
   - A task assigned to someone else is Not started, and nothing runs until its owner starts it on their own account.
   - Can't take it hands the task back to the creator with a reason and posts a room line.
   - Remind, Reassign and Edit before start, for the creator.
   - Reuse the existing thread, assign and queue machinery. Don't fork it.
4. A shared status classifier, `spaceTaskState(thread)`, in packages/shared. Its statuses: Not started, Working, Needs <person> with the reason (an answer or an approval), Failed, Limited, Stopped, In review, Done. Clients and @pair will import it. Test it thoroughly as a table.
5. Notifications:
   - A mention notifies only the named member.
   - Being assigned a task notifies the assignee.
   - Creating a space notifies the members added.
   - Follow decisions.md for everything else.
6. Room thread and @pair seams. The room thread exists. space.post with `pair` mentioned records the message and queues a run in one decision, exactly as spaces-agent §3 and §7 describe. Leave the run's provider unset or stubbed; the @pair agent is a separate handoff. Only human posts may queue a run.
7. MCP. Expose the space read and write operations as service methods that MCP tools can reach (see apps/server/src/mcp). Transports stay thin.

Out of scope: the @pair adapter, its tools and its notes UI; any client UI. Don't edit decisions.md. Its non-goal about @mentions is an open decision for maintainers. Note the conflict in your PR body instead.

Tests follow AGENTS.md "Verifying":
- Cover the orchestrator decisions, the permission guards, the projections, and the classifier.
- Drain OrchestrationEffectWorkerV2 and use no sleeps.
- Run `vp run check:changed` before you push.

Done when:
- The contracts compile across server, web and mobile, with no UI.
- Every action in the "Who can do what" table is enforced and tested.
- A space can be created, posted in, archived and unarchived through RPC and MCP.
- Tasks can be assigned and wait for their owner.
- A @pair mention queues a run.

When done, push `feat/space-core` and open a PR into `feat/space`. In the body, list the contract names the other agents will import.
```

---

## 2. @pair: the space agent

```text
You are building @pair, the persistent agent in a Pair Space (this repo, a fork of T3 Code).

Start: cut `feat/space-agent` from `feat/space` after the Core PR has merged into it, in a new worktree next to this checkout. Read AGENTS.md first and follow it.

The source of truth is docs/product/spaces-agent.md. Read all of it. Build its M1 (§13). Use docs/product/spaces.md for the product, and the screens 5, 5b and 10 in docs/product/spaces-prototype for how records, confirm cards, receipts, the queue and Retry look. Read evals/README.md before you write any model-facing text.

Scope (spaces-agent M1):
1. `spaceAgent`, an in-process ProviderAdapterV2 on the Messages API through `@anthropic-ai/sdk`, wrapped in Effect (§7, §8).
   - It runs only on room threads. No picker lists it.
   - It reports no checkpoint capability.
   - It refuses to steer.
   - It is paid by the Team Claude key provider instance.
   - It gets the cloud-only exception for room threads only (§7). Open decision §14.8 asks maintainers to accept this, so state it in the PR.
2. Context assembly, SpaceContext.assemble (§4): the fixed section order, budgets, and cache breakpoints. The tagger goes in a mid-conversation system message. Record usage per run.
3. Tools (§6), as service methods with the tagger's MCP invocation scope, limited to the space's tasks:
   - space_task_read
   - space_search, over the existing message index
   - space_message_read
   - space_task_create, one per reply
   - space_task_message, with the confirm path for someone else's task
   - space_notes_edit
4. Records and Undo (§7):
   - space.action.* commands and events.
   - The space_actions and space_notes projections.
   - Records written in the same transaction as the action.
   - Undo for the tagger only.
   - Enforce the never-steer guard in the orchestrator, not just in the prompt.
5. Notes (§5): structured items capped at 30 × 240 characters, sources, human edits win, and tombstones.
6. Queue behaviour (§3):
   - One reply at a time.
   - Cancel and Retry.
   - A failed reply doesn't block the queue, unless the key itself is limited.
   - Only people trigger a reply.
   - "Pair is replying to X" is static text.
7. Evals: create evals/space-agent/ and make cases 1–6 and 8–10 from §12 pass on Opus 5.5 and Sonnet 5.5. Each fix to model behaviour gets a case that fails before the fix.

Decisions you may not change: @pair replies only when tagged; it acts only as the tagger; it asks before touching someone else's task; it never steers and never approves; every action leaves a record with Undo; notes have sources.

Open decisions (§14): use the doc's recommendations and list each one you relied on in the PR body. In particular, support the team key only, without "My Claude account".

Client work: render records, confirm cards, receipts and the notes list only if the Web agent hasn't. Coordinate through the contracts, and don't duplicate their components.

Tests:
- Orchestrator decisions for each space.action.
- Projections.
- The never-steer guard.
- Trigger rules: an agent or token post starts nothing.
- Undo inverses.
- Notes caps and tombstones.
- Adapter protocol translation against a recorded Messages API stream. Make no live API calls in unit tests.
- Use the Replay (dev) provider to watch the UI.
- Run `vp run check:changed`.

When done, push `feat/space-agent` and open a PR into `feat/space`. Include the eval results and a measured cost and cache-read rate per reply from a dev run.
```

---

## 3. Web and desktop UI

```text
You are building the Spaces UI for Pair's web and desktop clients (this repo, a fork of T3 Code).

Start: cut `feat/space-web` from `feat/space` after the Core PR has merged into it, in a new worktree next to this checkout. Read AGENTS.md first, especially "Hit every surface", "Taste" and docs/internals/web-ui.md.

What to build: every screen in docs/product/spaces-prototype/README.md, except 9 (mobile).
- To see a screen, open docs/product/spaces-prototype/screens/<Screen>.dc.html in a browser, or run its render.sh. Append #state=<json>; the state keys are in each file's script comment.
- Live canvas: https://claude.ai/artifact/T4KuyZQeZVfH5Ax9PsZLgY
- Product rules: docs/product/spaces.md.
- The prototype's markup and CSS are a reference only. Build with the existing apps/web components, variants and tokens, the same way ChatHeader, the composer, RightPanelTabs, the sidebar rows and NewWorkspaceDialog are built. Add a variant only when the look is a generic concept. Add the two new tokens, --input-foreground and --destructive, to apps/web/src/index.css, in light and dark.

Scope:
1. Sidebar: Assigned to me with its count; a Spaces section with +; space rows with unread; sub-rows for tasks that need you, then "N more"; an Archived section.
2. Room:
   - Feed with posts, system lines and task chips with live status.
   - Inline quote-reply from a hover bar.
   - Mention autocomplete that inserts tokens.
   - Composer hints ("X will be notified" or "Pair replies here").
   - The archived read-only bar.
3. The room's right panel, following Capy: the Overview tab with the grouped sections and two-line rows, and the Notes tab with the Brief and Pair's notes (edit and remove on hover).
4. Task screen: the space in the header; an Overview tab in the existing panel; the unstarted states (Start, Runs on, Assign to…, Can't take it, Remind, Reassign, Edit); and member versus owner controls (locked model, Stop confirm).
5. Dialogs and popovers: New space (with its member picker), New task (with owner, model and base pickers), Space settings, the members popover, the remove, leave, transfer and archive confirms, and Not a member. Below 640px they become bottom sheets.
6. Entry points: the command palette and keybindings for New space and New task, and Settings where a setting belongs.
7. Shared logic goes in packages/client-runtime so mobile can reuse it: the status mapping through spaceTaskState, mention tokens, "for you" wording, and the ordering of sections and members.

If the @pair agent PR has merged, also render its records, confirm cards, receipts, queue and Retry lines (screens 5, 5b and 10). Otherwise build them against the contracts and leave a clear seam.

Performance: send deltas, not whole lists. Virtualize the feed the way the thread timeline does. Use no animations or spinners that repaint continuously.

Verify:
- Write browser tests only for logic that can break: mention parsing, permission-gated controls, the archived read-only state.
- For visual work, use before/after captures, not tests.
- Do one integrated pass in the real app with the test-t3-app skill, using the Replay (dev) provider.
- Check the narrow widths each screen names, and dark mode.
- Run `vp run check:changed`.

When done, push `feat/space-web` and open a PR into `feat/space` with screenshots of each screen next to its prototype render.
```

---

## 4. Mobile

```text
You are building Spaces for Pair's React Native app in apps/mobile (this repo, a fork of T3 Code).

Start: cut `feat/space-mobile` from `feat/space` after the Core and Web PRs have merged into it, in a new worktree next to this checkout. Read AGENTS.md first, and the test-t3-mobile skill.

What to build:
- Screen 9 in docs/product/spaces-prototype: open screens/MobileRoom.dc.html, or render it at 390×844 with render.sh.
- The mobile form of every room, task and dialog flow in docs/product/spaces.md. Use the web screens in that folder for behaviour, and use bottom sheets where web uses dialogs.
- Reuse packages/client-runtime for status, mentions, wording and ordering. Don't copy web logic.

Scope:
1. Spaces in the mobile navigation, with Assigned to me.
2. The room: feed, quote-reply, mention autocomplete, composer hints. The composer hides while a sheet is open.
3. The tasks sheet (Overview and Notes) and the members sheet, each with medium and large detents. Tap targets are at least 44px.
4. The task screen's unstarted states, and member versus owner controls.
5. New space, New task, settings, members, the remove, leave, transfer and archive confirms, and Not a member, as sheets.
6. @pair records, confirm cards and Undo, if the agent PR has merged.
7. Push notifications follow decisions.md: the title only, never message text.

Verify:
- If the native client is missing or stale, run `vp run mobile:install ios`.
- Make one integrated pass with test-t3-mobile, on iOS and Android, in light and dark.
- Run `vp run check:changed`.

When done, push `feat/space-mobile` and open a PR into `feat/space` with simulator screenshots next to the prototype renders.
```
