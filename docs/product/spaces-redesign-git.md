# Branch off: the git model

Status: proposal, 2026-11-14. This is the engineering side of [Spaces redesign](./spaces-redesign.md)
Part 2. That page says what people can count on, and this one says how git keeps those promises. The
implementing pull request moves the parts that stay true into the cloud docs, next to
[07 Access and data](./cloud/07-access-and-data.md), and deletes this note.

**Words.**

- The **source** is the thread someone branched off (Kousik's Prompt builder).
- The **branch** is the new thread (Hanad's Rationale per question).
- Both live in the project's mirror on Pair Cloud, so everything below works whether the branch runs
  on the source's machine or on a new one.

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

**Snapshots in pushes.** Snapshots stay in the mirror. They leave Pair only if the brancher pushes,
which the git button discourages while the source is open: "Pushing also includes Kousik's unpushed
work, authored as him."

**Update, step by step.** It runs between the branch's turns.

1. **Preflight.** Make the snapshot, and test-merge it into the branch in a temporary index. Report
   the files that would change and the files that conflict.
2. **Clean:** merge, and queue the agent note.
3. **Conflict, "let my agent resolve it":** start the merge, and start one turn with a fixed prompt
   to resolve the markers and commit.
4. **Conflict, "resolve it myself":** start the merge and stop.
5. **While the merge is open**, the thread shell carries `updateInProgress` with the conflicted paths.
   Offer and Undo update are refused. The merge completes when no conflicted path has markers and the
   merge is committed, by the agent or by the git button.
6. **Abort update** runs `git merge --abort`, and drops the snapshot from the chain.

**Undoing an Update.** A snapshot whose Update was undone no longer counts as on the branch, so the
next snapshot chains to the one before it.

- If the branch wasn't pushed, the undo resets the branch.
- If it was pushed, the undo adds a commit that reverts the merge.
- Either way, the next Update brings everything back.

## Offers

An offer carries the branch's own commits that are in effect on its tip and not on the source. It
never includes a snapshot, or a commit that undid one.

- **"In effect"** is decided by trees, not history: a commit's change is in effect on a tree when its
  diff applies to that tree in reverse. "To offer" counts these commits.
- **The diff** shown to the owner is those commits' combined change, so it shows only the sender's
  lines.
- **The check** before sending does a three-way apply onto the source's latest checkpoint tree,
  uncommitted work included. That is the tree Apply writes to.
- **Duplicates.** Commits are deduplicated by `git patch-id --stable`, keeping the newest, so a change
  that was cherry-picked back counts once.
- **One open offer per branch.** A new offer replaces the open one. Offers are records with a state
  (open, applied, declined, withdrawn, returned), not queue entries.
- **Bring them back.** When an Update merges in the source's revert of the branch's applied changes,
  the branch loses them too. The row's **Bring them back** cherry-picks them onto the branch again, as
  the brancher's commits.
  - Because they're in effect again, they count as "to offer" and apply cleanly.
  - If the branch has since edited the same lines, the cherry-pick conflicts and resolves as an
    Update does, in the branch's own worktree.

**Ahead and behind** are computed when a checkpoint commits, and are carried on the thread shell.
Nothing polls, and nothing wakes a machine to compute them.

## Apply, on the source

Apply writes no commits.

1. **Arming.** Apply is a step the orchestrator runs at the next turn boundary, before the next queued
   message. If the source is idle, that boundary is now.
2. **The check, again,** against the current checkpoint. If the turn that just ended introduced a
   conflict, the offer is marked `returned`, and the sender is notified.
3. **The write.** It goes through the source machine's workspace host.
   1. Re-capture the checkpoint. If any of the offer's files changed since the check, for example
      from a terminal edit or codegen, check again. Give up after three tries and return the offer.
   2. Merge the offer's tip onto that checkpoint tree, with the branch's base as the merge base.
   3. Write only the offer's files to the working tree, through a temporary index. Every other file
      keeps its bytes and its modification time, so the owner's running dev server reloads only what
      changed. `HEAD` and the real index stay as they are, and the owner's own uncommitted changes,
      even in the same files, are kept.
   4. Handle deletions and renames.

   Never use `git apply --3way` here: it refuses a file the owner has also changed, which is the
   normal case.
4. **The record.**
   - Capture a checkpoint labelled "Applied Hanad's changes · 3 files", and queue the agent note.
   - Record the lines the offer added, by file and content, against the offer's author. Lines that
     are only whitespace or punctuation, such as `}`, aren't recorded. The record ends when none of
     those lines remain uncommitted in those files.

**Credit.** Any commit in the owner's worktree that adds a recorded line to the file it was recorded
in gets `Co-authored-by: Hanad <email>`, whether the git button or the agent makes it.

- **Where the hook lives.** Pair turns on `extensions.worktreeConfig` and sets
  `git config --worktree core.hooksPath` to a Pair-owned folder for that worktree only. That folder is
  read-only to agents.
  - The extension applies to the whole clone, so Pair turns it on only in clones on cloud machines,
    never in a member's own checkout.
  - It needs git 2.20 or later, which the team image checks. Tools that read git config through a
    library, rather than the git command, must understand worktree config. The runner's own git calls
    use the command.
- **What it does.** Its `commit-msg` adds the trailer, then runs the project's own hook from the
  project's configured hooks path, or `$GIT_COMMON_DIR/hooks`. Husky, lefthook and similar setups keep
  working, and other worktrees are untouched.
- **What not to do.** Never write into the project's hooks folder, which may be tracked (`.husky/`).
  Never override `core.hooksPath` for the whole repository.
- **The note.** The agent note also asks the agent to credit Hanad.

**Revert Hanad's changes** is the same write in reverse, touching only those files, and is captured
as one checkpoint step. **Revert to a turn** before an Apply is T3 Code's existing file restore. Nothing on the source
side needs history rewriting.

## Tests

The snapshot and offer services' first tests come from cases the design reviews reproduced with real
git:

1. **The source revises its own uncommitted line.** Kousik changes a line, Hanad branches off and edits
   a different line, Kousik changes his line again, and Hanad updates. It merges cleanly.
2. **An Update after an Apply.** Hanad's changes are applied to Kousik's files, uncommitted, and
   Kousik's next turn edits another line. Hanad then updates. It merges cleanly, and "to offer" reads
   0.
3. **Undoing a pushed Update.** Hanad updates, pushes, undoes the Update and updates again. All of the
   source's work is back, and Hanad's next offer doesn't contain the undo's commit.
4. **Revert Hanad's changes, before Hanad updates.** Kousik reverts the applied changes, then Hanad
   updates. Hanad keeps his lines, the row reads "You still have them here", "to offer" counts them,
   and offering them again applies cleanly.
5. **Revert Hanad's changes, after Hanad updated.** Hanad updates after the Apply and keeps working,
   then Kousik reverts, then Hanad updates.
   - Hanad's lines are gone, the row offers **Bring them back**, and "to offer" doesn't count them.
   - An offer of a later fix alone applies cleanly.
   - After Bring them back, the reverted commits count once each, by patch id, and apply cleanly.
   - In a variant where Hanad has edited the same line since, Bring them back conflicts and resolves
     in his worktree.
6. **A conflicted Update, aborted.** The preflight lists the conflicting file. Abort update restores
   the branch and its chain, and the next Update previews the same conflict.
7. **An agent leaves markers.** "Let my agent resolve it" ends its turn with markers still in a file.
   The pinned row stays, and Offer stays refused.
8. **Apply against the queue.** An armed Apply and a queued message reach the same turn boundary. The
   Apply runs first, and the queued message's turn sees the applied files.
9. **Credit.** After an Apply:
   - The git button's next commit of those lines carries `Co-authored-by: Hanad`. A commit that
     includes none of them doesn't.
   - The same holds for an agent's commit in a repository whose own `core.hooksPath` points at a
     husky folder. The project's hook still runs, and the tracked folder is untouched.
10. **Apply on a busy tree.**
    - The owner has uncommitted edits in a file the offer also touches. Apply keeps both.
    - Files the offer doesn't touch keep their modification times.
    - If a terminal edit lands in one of the offer's files between the check and the write, Apply
      checks again, and returns the offer after three tries.
11. **Credit doesn't spread.** A later commit that only adds `}` or blank lines, or adds Hanad's line
    to a different file, carries no trailer.
