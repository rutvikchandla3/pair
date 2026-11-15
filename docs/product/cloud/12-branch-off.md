# 12 Branch off: the git model

How git keeps the promises of [Spaces redesign](../spaces-redesign.md) Part 2: a teammate's own
branch of a cloud thread, Update, Offer and Apply. The product rules are on that page; this one
says how git keeps them, and which traps the code works around. The git operations live in
[LineageGit.ts](../../../apps/server/src/lineage/LineageGit.ts), the actions in
[BranchLineageService.ts](../../../apps/server/src/lineage/BranchLineageService.ts) and
[BranchOffServiceLive.ts](../../../apps/server/src/lineage/BranchOffServiceLive.ts).

**Words.**

- The **source** is the thread someone branched off (Kousik's Prompt builder).
- The **branch** is the new thread (Hanad's Rationale per question).
- Both live in the project's [mirror](./07-access-and-data.md#where-the-mirror-lives), so everything
  below works whether the branch runs on the source's machine or on a new one.

## Where a branch runs

- **The source's machine.** The branch is a new worktree of the same clone, next to the source's
  checkout, and its thread joins the source's sandbox. This deliberately lifts "unrelated threads
  never join a sandbox" ([04](./04-sandbox-lifecycle.md#shared-sandboxes-side-chats-and-forks)):
  fork and side chat still share the source's checkout, Branch off never does. Each thread on a
  machine gets a stable slot, the smallest free one at attach, and `PAIR_THREAD_SLOT=<slot>` and
  `PORT=<3000 + slot>` in its provider, terminal and script environments, spread after team and
  project env.
- **A new machine.** The snapshot and a branch ref for the new thread go into the mirror, and the
  machine checks the branch out from there through the seeded-launch path. Its access list starts
  as the source machine's audience.
- **Moving.** `thread.machine.move` re-points one thread's sandbox and worktree in one commit, which
  is how **Move to my own machine** and **Move it to Hanad's own machine first** work.
- **Carrying commits.** Threads on one clone share objects. Otherwise
  [LineageReposLive.ts](../../../apps/server/src/lineage/LineageReposLive.ts) imports the commits
  into the mirror under `refs/t3/lineage/<thread>/<sha>`, from the sending machine only if it is
  ready, and bundles them into the receiving clone. Nothing wakes a sleeping machine to compute
  ahead and behind.

## Snapshots, on the branch

Agents leave their turns uncommitted, and a checkpoint is a hidden ref of the working tree. A branch
takes the source's work as a **snapshot** commit:

- **Its tree** is the source's checkpoint.
- **Its author** is the source's owner, with the message "Kousik's work in progress, turn 7". The
  committer is the server, as for every Pair commit.
- **Its parents** are the source's `HEAD` and the newest snapshot still on the branch.
- **Branch off** starts the branch at a snapshot. **Update** creates a snapshot and merges it into the
  branch.
- The newest snapshot still on the branch is the branch's **base**.

Consecutive snapshots are chained, so an Update's merge base is the previous snapshot, not the
source's last commit. That way the source's agent revising its own uncommitted lines never conflicts
with itself.

Git commits are deterministic: re-snapshotting the same tree with the same parents in the same
second returns the same commit, and the next Update would do nothing. `createSnapshot` takes every
snapshot already made for the branch and bumps the author date when it would collide.

**Snapshots in pushes.** Snapshots stay in the mirror. They leave Pair only if the brancher pushes,
which the git button discourages while the source is open.

## Update

It runs between the branch's turns; during a turn it is armed and runs at the boundary.

1. **Preview.** Make the snapshot and test-merge it into the branch's working tree state (`HEAD`
   plus uncommitted work, captured through a scratch index) with `git merge-tree --write-tree
   --merge-base=<base>`. Report the files that would change and the files that conflict.
2. **Start.** If the branch has uncommitted work, commit it first as the brancher, so `git merge`
   can't refuse a dirty file. Server commits use `--no-verify`, so a project's pre-commit hook
   can't block an update.
3. **Clean:** merge, and tell the agent on its next turn.
4. **Conflict, "let my agent resolve it":** start the merge, and start one turn with a fixed prompt
   to resolve the markers and commit.
5. **Conflict, "resolve it myself":** start the merge and stop.
6. **While the merge is open**, the thread shell carries `updateInProgress` with the conflicted
   paths, and each turn tells the agent. Offer and Undo update are refused. The merge completes when
   it is committed and no conflicted path still has markers.
7. **Abort update** runs `git merge --abort`, resets to the pre-update head and leaves the work it
   committed uncommitted again, byte for byte, and drops the snapshot from the chain.

**Undoing an Update.** A snapshot whose Update was undone no longer counts as on the branch, so the
next snapshot chains to the one before it. If the branch wasn't pushed, the undo resets it (`reset
--keep`, so it refuses rather than overwrite edits). If it was, the undo adds a commit that reverts
the merge, and offers exclude that commit. Either way, the next Update brings everything back.

## Offers

An offer carries the branch's own commits that are in effect on its tip and not on the source. It
never includes a snapshot, or a commit that undid one.

- **"In effect"** is decided by trees, not history: a commit's change is in effect on a tree when its
  diff applies to that tree in reverse. The check uses one line of context: with git's default three,
  a later fix three lines from a reverted line stops counting.
- **The diff** shown to the owner is those commits' combined change, built as a synthetic commit on
  the branch's base by in-memory cherry-picks, so it shows only the sender's lines.
- **The check** before sending is a three-way merge onto the source's latest checkpoint tree,
  uncommitted work included. That is the tree Apply writes to.
- **Duplicates.** Commits are deduplicated by `git patch-id --stable`, keeping the newest, so a change
  that was cherry-picked back counts once.
- **One open offer per branch.** A new offer replaces the open one. Offers are records with a state
  (open, applied, declined, withdrawn, returned), not queue entries, so an undecided offer holds
  nothing up.
- **Bring them back.** When an Update merges in the source's revert of the branch's applied changes,
  the branch loses them too. **Bring them back** cherry-picks them onto the branch again, one at a
  time, re-authored as the brancher. A conflict resolves as an Update's does.

**Ahead and behind** are computed after a checkpoint commits and carried on the thread shell. Nothing
polls.

## Apply, on the source

Apply writes no commits.

1. **Arming.** Apply is a step the orchestrator runs at the next turn boundary, before the next queued
   message. If the source is idle, that boundary is now.
2. **The check, again,** against the current tree. If the turn that just ended introduced a conflict,
   the offer is `returned`, and the sender is notified.
3. **The write**, through the source machine's workspace host:
   1. Re-capture the working tree. If any of the offer's files changed since the check (a terminal
      edit, codegen), check again. Give up after three tries and return the offer.
   2. Merge the offer's tip onto that tree, with the branch's base as the merge base.
   3. Write only the offer's files, through a scratch index (`read-tree`, then `checkout-index` for
      those paths), and delete removed ones. Every other file keeps its bytes and modification time,
      so a running dev server reloads only what changed. `HEAD` and the real index stay as they are,
      and the owner's uncommitted changes, even in the same files, are kept.

   Never use `git apply --3way` here: it refuses a file the owner has also changed, which is the
   normal case.

4. **The record.** A turn-base ref, `refs/t3/lineage/turn-base/<scope>/ordinal/<N>`, captures the tree
   after the step. The next turn's changed-files summary diffs from it, so an Apply or Update never
   counts as the agent's work, while turn N's own checkpoint is untouched, so **Revert to a turn**
   before the Apply discards it with the existing restore. The agent is told on its next turn, and
   the lines the offer added are recorded for credit.

**Revert Hanad's changes** is the same write in reverse (merge base the offer's tip, theirs its base),
touching only those files, and is recorded the same way.

## Credit

Any commit in the owner's worktree that adds a recorded line to the file it was recorded in gets
`Co-authored-by: Hanad <email>`, whether the git button or the agent makes it. Lines that are only
whitespace, punctuation or symbols, such as `}`, aren't recorded, and the record ends when none of its
lines remain uncommitted.

- **Where the hook lives.** Pair turns on `extensions.worktreeConfig` and sets
  `git config --worktree core.hooksPath` to `<git dir>/pair/hooks`, in that worktree's private git
  directory, so agents never see it in the tree. Pair does this only on cloud machines, never in a
  member's own checkout. The record sits beside it (`pair/credit.json`, and one folder per entry so the
  `sh` hook matches lines with `grep -Fx` without parsing JSON).
- **What it does.** `commit-msg` adds the trailer, then runs the project's own hook from the
  repository's configured hooks path, or `$GIT_COMMON_DIR/hooks`. Every other hook name forwards the
  same way, so husky and lefthook keep working and other worktrees are untouched. Server clones set
  `core.hooksPath=/dev/null`; the forwarding keeps that.
- **What not to do.** Never write into the project's hooks folder, which may be tracked (`.husky/`).
  Never override `core.hooksPath` for the whole repository.
- **Git version.** `merge-tree --write-tree --merge-base` needs git 2.40 or later; the team image must
  have it. Tools that read git config through a library must understand worktree config.

The cases the design reviews reproduced with real git run in
[LineageGit.test.ts](../../../apps/server/src/lineage/LineageGit.test.ts), on the local host and the
loopback runner.
