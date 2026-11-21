import * as NodeOS from "node:os";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { describe } from "vite-plus/test";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceHostLoopback from "../workspaceHost/WorkspaceHostLoopback.ts";
import type * as WorkspaceHosts from "../workspaceHost/WorkspaceHosts.ts";
import * as WorkspaceHostTesting from "../workspaceHost/WorkspaceHostTesting.ts";
import * as LineageGit from "./LineageGit.ts";

const PAIR_EMAIL = "pair@users.noreply.github.com";

const makeLayerTest = (
  layerHosts: Layer.Layer<WorkspaceHosts.WorkspaceHosts, never, NodeServices.NodeServices>,
) =>
  LineageGit.layer.pipe(
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(layerHosts),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
// The loopback host carries every git call, scratch file and hook write through the runner protocol.
const hostLayers = [
  ["local", makeLayerTest(WorkspaceHostTesting.layerFromContext)],
  ["loopback", makeLayerTest(WorkspaceHostLoopback.layerLoopback(NodeOS.tmpdir()))],
] as const;

type TestServices =
  | LineageGit.LineageGit
  | VcsProcess.VcsProcess
  | FileSystem.FileSystem
  | Path.Path
  | Scope.Scope;

const KOUSIK = { name: "Kousik", email: "kousik@example.com" };
const HANAD = { name: "Hanad", email: "hanad@example.com" };
const HANAD_COAUTHOR = "Hanad <hanad@example.com>";
const HANAD_TRAILER = `Co-authored-by: ${HANAD_COAUTHOR}`;
const APP = "src/app.ts";
const FEATURE = "src/feature.ts";
const OTHER = "src/other.ts";
const HANAD_LINE = 'export const v15 = "rationale per question";';
const APP_LINES = Array.from(
  { length: 20 },
  (_, index) => `export const v${index + 1} = ${index + 1};`,
);

const fixture = (options: { readonly huskyMarker?: string } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const vcs = yield* VcsProcess.VcsProcess;
    const lineage = yield* LineageGit.LineageGit;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "lineage-git-" }));
    const clone = path.join(root, "clone");
    const source = path.join(root, "prompt-builder");
    const branch = path.join(root, "rationale");

    const gitResult = (
      cwd: string,
      args: ReadonlyArray<string>,
      input: { readonly env?: NodeJS.ProcessEnv; readonly stdin?: string } = {},
    ) =>
      vcs
        .run({
          operation: "LineageGit.test",
          command: "git",
          cwd,
          args,
          allowNonZeroExit: true,
          ...(input.env === undefined ? {} : { env: input.env }),
          ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
        })
        .pipe(Effect.orDie);
    const git = (
      cwd: string,
      args: ReadonlyArray<string>,
      input: { readonly env?: NodeJS.ProcessEnv; readonly stdin?: string } = {},
    ) =>
      gitResult(cwd, args, input).pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result.stdout.trim())
            : Effect.die(new Error(`git ${args.join(" ")}: ${result.stderr}`)),
        ),
      );
    const read = (cwd: string, file: string) =>
      fs.readFileString(path.join(cwd, file)).pipe(Effect.orDie);
    const write = (cwd: string, file: string, text: string) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(path.join(cwd, file)), { recursive: true });
        yield* fs.writeFileString(path.join(cwd, file), text);
      }).pipe(Effect.orDie);
    const editLine = (cwd: string, file: string, line: number, text: string) =>
      Effect.gen(function* () {
        const lines = (yield* read(cwd, file)).split("\n");
        lines[line - 1] = text;
        yield* write(cwd, file, lines.join("\n"));
      });
    const lineOf = (cwd: string, file: string, line: number) =>
      read(cwd, file).pipe(Effect.map((text) => text.split("\n")[line - 1]));
    const head = (cwd: string) => git(cwd, ["rev-parse", "HEAD"]);
    const commitAs = (cwd: string, author: LineageGit.LineageAuthor, message: string) =>
      Effect.gen(function* () {
        yield* git(cwd, ["add", "-A"]);
        yield* git(cwd, ["commit", "--quiet", "-m", message], {
          env: { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email },
        });
        return yield* head(cwd);
      });
    const lastMessage = (cwd: string) => git(cwd, ["log", "-1", "--format=%B"]);

    yield* fs.makeDirectory(clone).pipe(Effect.orDie);
    yield* git(clone, ["init", "--quiet", "--initial-branch=main"]);
    yield* git(clone, ["config", "user.name", "Pair server"]);
    yield* git(clone, ["config", "user.email", "server@example.com"]);
    yield* write(clone, APP, `${APP_LINES.join("\n")}\n`);
    yield* write(clone, FEATURE, "export const feature = 1;\n");
    yield* write(clone, OTHER, "export const other = 1;\n");
    yield* write(clone, "notes.md", "# Notes\n");
    if (options.huskyMarker !== undefined) {
      yield* write(
        clone,
        ".husky/commit-msg",
        `#!/bin/sh\necho "commit-msg $1" >> '${options.huskyMarker}'\n`,
      );
      yield* fs.chmod(path.join(clone, ".husky/commit-msg"), 0o755).pipe(Effect.orDie);
      // The test setup turns core.fileMode off, so the executable bit is staged by hand.
      yield* git(clone, ["add", ".husky/commit-msg"]);
      yield* git(clone, ["update-index", "--chmod=+x", ".husky/commit-msg"]);
      yield* git(clone, ["config", "core.hooksPath", ".husky"]);
    }
    yield* commitAs(clone, KOUSIK, "Initial commit");
    yield* git(clone, ["worktree", "add", "--quiet", "-b", "prompt-builder", source, "main"]);

    // Every snapshot and undo commit ever made; offers never carry them.
    const madeCommits: string[] = [];
    const checkpoint = () =>
      lineage.worktreeTree({ cwd: source }).pipe(Effect.map((tree) => tree.commit));
    const snapshot = (previousSnapshot: string | null) =>
      Effect.gen(function* () {
        const sha = yield* lineage.createSnapshot({
          cwd: source,
          checkpoint: yield* checkpoint(),
          sourceHead: yield* head(source),
          previousSnapshot,
          author: KOUSIK,
          message: "Kousik's work in progress, turn 1",
          avoid: madeCommits,
        });
        madeCommits.push(sha);
        return sha;
      });
    const branchOff = () =>
      Effect.gen(function* () {
        const start = yield* snapshot(null);
        yield* lineage.addBranchWorktree({
          repoCwd: source,
          worktreePath: branch,
          branch: "rationale",
          startCommit: start,
        });
        return start;
      });
    const update = (base: string) =>
      Effect.gen(function* () {
        const next = yield* snapshot(base);
        const preview = yield* lineage.previewUpdate({ cwd: branch, snapshot: next, base });
        const started = yield* lineage.startUpdate({
          cwd: branch,
          snapshot: next,
          author: HANAD,
          message: "Update from Prompt builder",
          wipMessage: "Hanad's work before update from Prompt builder",
        });
        return { snapshot: next, preview, started };
      });
    const merged = (started: LineageGit.StartedUpdate<LineageGit.UpdateResult>) => {
      assert.equal(started.result.type, "merged");
      return started.result.type === "merged" ? started.result.mergeCommit : "";
    };
    const offer = (base: string) =>
      Effect.gen(function* () {
        const against = yield* checkpoint();
        const commits = yield* lineage.offerCommits({
          cwd: branch,
          sourceHead: yield* head(source),
          sourceTree: against,
          exclude: madeCommits,
        });
        const built = yield* lineage.buildOffer({
          cwd: branch,
          base,
          commits: commits.map((commit) => commit.sha),
          author: HANAD,
          message: "Hanad's changes from Rationale per question",
        });
        const check = yield* lineage.checkOffer({ cwd: source, base, tip: built.tip, against });
        return { commits, built, check };
      });
    const apply = (base: string, tip: string, beforeWrite?: Effect.Effect<void>) =>
      lineage.applyOffer({ cwd: source, base, tip, ...(beforeWrite ? { beforeWrite } : {}) });
    const applied = (result: LineageGit.ApplyResult) => {
      assert.equal(result.type, "applied");
      return result.type === "applied" ? result : { files: [], addedLines: [] };
    };

    return {
      fs,
      path,
      lineage,
      root,
      clone,
      source,
      branch,
      madeCommits,
      git,
      gitResult,
      read,
      write,
      editLine,
      lineOf,
      head,
      commitAs,
      lastMessage,
      checkpoint,
      snapshot,
      branchOff,
      update,
      merged,
      offer,
      apply,
      applied,
    };
  });

describe.each(hostLayers)("LineageGit on the %s host", (_hostKind, layerTest) => {
  const run = <A, E>(effect: Effect.Effect<A, E, TestServices>) =>
    effect.pipe(Effect.provide(layerTest), Effect.scoped);

  it.live("1. The source revises its own uncommitted line", () =>
    run(
      Effect.gen(function* () {
        const t = yield* fixture();
        const sourceHead = yield* t.head(t.source);
        yield* t.editLine(t.source, APP, 2, 'export const v2 = "kousik draft";');
        const start = yield* t.branchOff();
        assert.deepEqual(
          (yield* t.git(t.source, ["log", "-1", "--format=%P%n%an%n%ce%n%s", start])).split("\n"),
          [sourceHead, "Kousik", PAIR_EMAIL, "Kousik's work in progress, turn 1"],
        );
        assert.equal(yield* t.lineOf(t.branch, APP, 2), 'export const v2 = "kousik draft";');
        const again = yield* t.lineage
          .addBranchWorktree({
            repoCwd: t.source,
            worktreePath: t.path.join(t.root, "again"),
            branch: "rationale",
            startCommit: start,
          })
          .pipe(Effect.flip);
        assert.equal(again._tag === "LineageGitError" ? again.reason : again._tag, "branch-exists");

        yield* t.editLine(t.branch, APP, 15, HANAD_LINE);
        yield* t.commitAs(t.branch, HANAD, "Rationale per question");
        yield* t.editLine(t.source, APP, 2, 'export const v2 = "kousik final";');
        const { snapshot, preview, started } = yield* t.update(start);

        assert.deepEqual(preview, { files: [{ path: APP, status: "clean" }], conflicts: [] });
        t.merged(started);
        assert.equal(started.wipCommit, null);
        assert.equal(
          yield* t.git(t.source, ["log", "-1", "--format=%P", snapshot]),
          `${sourceHead} ${start}`,
        );
        assert.equal(yield* t.lineOf(t.branch, APP, 2), 'export const v2 = "kousik final";');
        assert.equal(yield* t.lineOf(t.branch, APP, 15), HANAD_LINE);
      }),
    ),
  );

  it.live("2. An Update after an Apply", () =>
    run(
      Effect.gen(function* () {
        const t = yield* fixture();
        yield* t.editLine(t.source, APP, 2, 'export const v2 = "kousik";');
        const start = yield* t.branchOff();
        yield* t.editLine(t.branch, APP, 15, HANAD_LINE);
        yield* t.commitAs(t.branch, HANAD, "Rationale per question");
        const { built, check } = yield* t.offer(start);
        assert.isTrue(check.clean);
        t.applied(yield* t.apply(start, built.tip));
        assert.equal(yield* t.lineOf(t.source, APP, 15), HANAD_LINE);

        yield* t.editLine(t.source, APP, 8, 'export const v8 = "kousik next turn";');
        const { preview, started } = yield* t.update(start);

        assert.deepEqual(preview.conflicts, []);
        t.merged(started);
        assert.equal(yield* t.lineOf(t.branch, APP, 8), 'export const v8 = "kousik next turn";');
        const toOffer = yield* t.lineage.offerCommits({
          cwd: t.branch,
          sourceHead: yield* t.head(t.source),
          sourceTree: yield* t.checkpoint(),
          exclude: t.madeCommits,
        });
        assert.deepEqual(toOffer, []);
      }),
    ),
  );

  it.live("3. Undoing a pushed Update", () =>
    run(
      Effect.gen(function* () {
        const t = yield* fixture();
        const KOUSIK_V5 = 'export const v5 = "kousik";';
        yield* t.editLine(t.source, APP, 2, 'export const v2 = "kousik";');
        const start = yield* t.branchOff();
        yield* t.editLine(t.branch, APP, 15, HANAD_LINE);
        const hanadCommit = yield* t.commitAs(t.branch, HANAD, "Rationale per question");
        yield* t.editLine(t.source, APP, 5, KOUSIK_V5);

        // Not pushed yet: the undo resets the branch.
        const first = yield* t.update(start);
        const firstMerge = t.merged(first.started);
        const unpushed = yield* t.lineage.undoUpdate({
          cwd: t.branch,
          mergeCommit: firstMerge,
          preUpdateHead: first.started.preUpdateHead,
          wipCommit: first.started.wipCommit,
          pushed: false,
          author: HANAD,
        });
        assert.deepEqual(unpushed, { undoCommit: null });
        assert.equal(yield* t.head(t.branch), hanadCommit);
        assert.equal(yield* t.lineOf(t.branch, APP, 5), APP_LINES[4]);

        // The undone snapshot no longer counts, so the next one chains to the start again.
        const second = yield* t.update(start);
        assert.notEqual(second.snapshot, first.snapshot);
        const secondMerge = t.merged(second.started);
        assert.equal(yield* t.lineOf(t.branch, APP, 5), KOUSIK_V5);
        const remote = t.path.join(t.root, "remote.git");
        yield* t.git(t.root, ["init", "--quiet", "--bare", remote]);
        yield* t.git(t.branch, ["push", "--quiet", remote, "rationale"]);

        const pushed = yield* t.lineage.undoUpdate({
          cwd: t.branch,
          mergeCommit: secondMerge,
          preUpdateHead: second.started.preUpdateHead,
          wipCommit: second.started.wipCommit,
          pushed: true,
          author: HANAD,
        });
        assert.isNotNull(pushed.undoCommit);
        t.madeCommits.push(pushed.undoCommit!);
        assert.equal(yield* t.git(t.branch, ["rev-parse", "HEAD^"]), secondMerge);
        assert.equal(yield* t.git(t.branch, ["log", "-1", "--format=%an"]), "Hanad");
        assert.equal(yield* t.lineOf(t.branch, APP, 5), APP_LINES[4]);

        const third = yield* t.update(start);
        t.merged(third.started);
        assert.equal(yield* t.lineOf(t.branch, APP, 2), 'export const v2 = "kousik";');
        assert.equal(yield* t.lineOf(t.branch, APP, 5), KOUSIK_V5);
        assert.equal(yield* t.lineOf(t.branch, APP, 15), HANAD_LINE);

        const { commits, built, check } = yield* t.offer(third.snapshot);
        assert.deepEqual(
          commits.map((commit) => commit.sha),
          [hanadCommit],
        );
        assert.deepEqual(built.files, [
          { path: APP, status: "modified", additions: 1, deletions: 1 },
        ]);
        assert.isTrue(check.clean);
      }),
    ),
  );

  it.live("4. Revert Hanad's changes, before Hanad updates", () =>
    run(
      Effect.gen(function* () {
        const t = yield* fixture();
        yield* t.editLine(t.source, APP, 2, 'export const v2 = "kousik";');
        const start = yield* t.branchOff();
        yield* t.editLine(t.branch, APP, 15, HANAD_LINE);
        const hanadCommit = yield* t.commitAs(t.branch, HANAD, "Rationale per question");
        const first = yield* t.offer(start);
        t.applied(yield* t.apply(start, first.built.tip));

        const reverted = yield* t.lineage.revertOffer({
          cwd: t.source,
          base: start,
          tip: first.built.tip,
        });
        assert.equal(reverted.type, "reverted");
        assert.equal(yield* t.lineOf(t.source, APP, 15), APP_LINES[14]);
        assert.equal(yield* t.lineOf(t.source, APP, 2), 'export const v2 = "kousik";');

        const { snapshot, started } = yield* t.update(start);
        t.merged(started);
        assert.equal(yield* t.lineOf(t.branch, APP, 15), HANAD_LINE);

        const again = yield* t.offer(snapshot);
        assert.deepEqual(
          again.commits.map((commit) => commit.sha),
          [hanadCommit],
        );
        assert.isTrue(again.check.clean);
        t.applied(yield* t.apply(snapshot, again.built.tip));
        assert.equal(yield* t.lineOf(t.source, APP, 15), HANAD_LINE);
      }),
    ),
  );

  // Hanad's applied change is merged back into his branch, he fixes something else, then Kousik
  // reverts the applied change and Hanad updates again.
  const revertedAfterUpdate = Effect.gen(function* () {
    const t = yield* fixture();
    yield* t.editLine(t.source, APP, 2, 'export const v2 = "kousik";');
    const start = yield* t.branchOff();
    yield* t.editLine(t.branch, APP, 15, HANAD_LINE);
    const hanadCommit = yield* t.commitAs(t.branch, HANAD, "Rationale per question");
    const first = yield* t.offer(start);
    t.applied(yield* t.apply(start, first.built.tip));
    yield* t.editLine(t.source, APP, 3, 'export const v3 = "kousik";');
    const firstUpdate = yield* t.update(start);
    t.merged(firstUpdate.started);
    yield* t.editLine(t.branch, APP, 18, 'export const v18 = "hanad fix";');
    const fixCommit = yield* t.commitAs(t.branch, HANAD, "Fix v18");
    const reverted = yield* t.lineage.revertOffer({
      cwd: t.source,
      base: start,
      tip: first.built.tip,
    });
    assert.equal(reverted.type, "reverted");
    const secondUpdate = yield* t.update(firstUpdate.snapshot);
    t.merged(secondUpdate.started);
    return { t, base: secondUpdate.snapshot, hanadCommit, fixCommit };
  });

  it.live("5. Revert Hanad's changes, after Hanad updated", () =>
    run(
      Effect.gen(function* () {
        const { t, base, hanadCommit, fixCommit } = yield* revertedAfterUpdate;
        assert.equal(yield* t.lineOf(t.branch, APP, 15), APP_LINES[14]);

        const fixOnly = yield* t.offer(base);
        assert.deepEqual(
          fixOnly.commits.map((commit) => commit.sha),
          [fixCommit],
        );
        assert.isTrue(fixOnly.check.clean);
        t.applied(yield* t.apply(base, fixOnly.built.tip));
        assert.equal(yield* t.lineOf(t.source, APP, 18), 'export const v18 = "hanad fix";');
        assert.equal(yield* t.lineOf(t.source, APP, 15), APP_LINES[14]);

        const broughtBack = yield* t.lineage.cherryPickBack({
          cwd: t.branch,
          commits: [hanadCommit],
          author: HANAD,
          wipMessage: "Hanad's work before bringing back his changes",
        });
        assert.equal(broughtBack.result.type, "picked");
        const [picked] = broughtBack.result.type === "picked" ? broughtBack.result.commits : [];
        assert.notEqual(picked, hanadCommit);
        assert.equal(yield* t.git(t.branch, ["log", "-1", "--format=%an", picked!]), "Hanad");
        assert.equal(yield* t.lineOf(t.branch, APP, 15), HANAD_LINE);

        const again = yield* t.offer(base);
        assert.deepEqual(
          again.commits.map((commit) => commit.sha),
          [picked],
        );
        assert.isTrue(again.check.clean);
        t.applied(yield* t.apply(base, again.built.tip));
        assert.equal(yield* t.lineOf(t.source, APP, 15), HANAD_LINE);
        assert.equal(yield* t.lineOf(t.source, APP, 18), 'export const v18 = "hanad fix";');
      }),
    ),
  );

  it.live(
    "5. Revert Hanad's changes, after Hanad updated: Bring them back conflicts with a later edit",
    () =>
      run(
        Effect.gen(function* () {
          const { t, hanadCommit } = yield* revertedAfterUpdate;
          yield* t.editLine(t.branch, APP, 15, 'export const v15 = "rationale v2";');
          yield* t.commitAs(t.branch, HANAD, "Rework v15");

          const broughtBack = yield* t.lineage.cherryPickBack({
            cwd: t.branch,
            commits: [hanadCommit],
            author: HANAD,
            wipMessage: "Hanad's work before bringing back his changes",
          });
          assert.deepEqual(broughtBack.result, {
            type: "conflicted",
            conflictedPaths: [APP],
            picked: [],
            remaining: [],
          });
          assert.deepEqual(
            yield* t.lineage.updateState({ cwd: t.branch, conflictedPaths: [APP] }),
            {
              mergeOpen: true,
              pathsWithMarkers: [APP],
            },
          );

          yield* t.write(
            t.branch,
            APP,
            `${APP_LINES.map((line, index) => (index === 14 ? HANAD_LINE : line)).join("\n")}\n`,
          );
          yield* t.git(t.branch, ["add", "-A"]);
          yield* t.git(t.branch, ["commit", "--quiet", "--no-edit"]);
          assert.deepEqual(
            yield* t.lineage.updateState({ cwd: t.branch, conflictedPaths: [APP] }),
            {
              mergeOpen: false,
              pathsWithMarkers: [],
            },
          );
        }),
      ),
  );

  it.live("6. A conflicted Update, aborted", () =>
    run(
      Effect.gen(function* () {
        const t = yield* fixture();
        const start = yield* t.branchOff();
        yield* t.editLine(t.branch, APP, 10, 'export const v10 = "hanad";');
        yield* t.commitAs(t.branch, HANAD, "Hanad v10");
        yield* t.editLine(t.branch, APP, 18, 'export const v18 = "hanad, uncommitted";');
        yield* t.write(t.branch, "notes/hanad.md", "untracked\n");
        yield* t.editLine(t.source, APP, 10, 'export const v10 = "kousik";');
        const before = {
          head: yield* t.head(t.branch),
          status: yield* t.git(t.branch, ["status", "--porcelain", "--untracked-files=all"]),
          app: yield* t.read(t.branch, APP),
          notes: yield* t.read(t.branch, "notes/hanad.md"),
        };

        const { preview, started } = yield* t.update(start);
        assert.deepEqual(preview, { files: [{ path: APP, status: "conflict" }], conflicts: [APP] });
        assert.deepEqual(started.result, { type: "conflicted", conflictedPaths: [APP] });
        assert.isNotNull(started.wipCommit);

        yield* t.lineage.abortUpdate({
          cwd: t.branch,
          preUpdateHead: started.preUpdateHead,
          wipCommit: started.wipCommit,
        });
        assert.deepEqual(
          {
            head: yield* t.head(t.branch),
            status: yield* t.git(t.branch, ["status", "--porcelain", "--untracked-files=all"]),
            app: yield* t.read(t.branch, APP),
            notes: yield* t.read(t.branch, "notes/hanad.md"),
          },
          before,
        );

        // The aborted snapshot left the chain, so the next one chains to the start again.
        const next = yield* t.snapshot(start);
        assert.deepEqual(
          yield* t.lineage.previewUpdate({ cwd: t.branch, snapshot: next, base: start }),
          preview,
        );
      }),
    ),
  );

  it.live("7. An agent leaves markers", () =>
    run(
      Effect.gen(function* () {
        const t = yield* fixture();
        const start = yield* t.branchOff();
        yield* t.editLine(t.branch, APP, 10, 'export const v10 = "hanad";');
        yield* t.commitAs(t.branch, HANAD, "Hanad v10");
        yield* t.editLine(t.source, APP, 10, 'export const v10 = "kousik";');
        const { started } = yield* t.update(start);
        assert.deepEqual(started.result, { type: "conflicted", conflictedPaths: [APP] });
        assert.deepEqual(yield* t.lineage.updateState({ cwd: t.branch, conflictedPaths: [APP] }), {
          mergeOpen: true,
          pathsWithMarkers: [APP],
        });

        // The agent's turn commits the merge with the markers still in the file.
        yield* t.git(t.branch, ["add", "-A"]);
        yield* t.git(t.branch, ["commit", "--quiet", "--no-edit"]);
        assert.deepEqual(yield* t.lineage.updateState({ cwd: t.branch, conflictedPaths: [APP] }), {
          mergeOpen: false,
          pathsWithMarkers: [APP],
        });

        yield* t.write(
          t.branch,
          APP,
          `${APP_LINES.map((line, index) => (index === 9 ? 'export const v10 = "both";' : line)).join("\n")}\n`,
        );
        yield* t.commitAs(t.branch, HANAD, "Resolve v10");
        assert.deepEqual(yield* t.lineage.updateState({ cwd: t.branch, conflictedPaths: [APP] }), {
          mergeOpen: false,
          pathsWithMarkers: [],
        });
      }),
    ),
  );

  // The orchestration half (an armed Apply runs before the queued message) belongs to the projections slice.
  it.live("8. Apply against the queue", () =>
    run(
      Effect.gen(function* () {
        const t = yield* fixture();
        const start = yield* t.branchOff();
        yield* t.editLine(t.branch, APP, 15, HANAD_LINE);
        yield* t.commitAs(t.branch, HANAD, "Rationale per question");
        const { built } = yield* t.offer(start);
        t.applied(yield* t.apply(start, built.tip));

        const nextTurnBaseline = yield* t.checkpoint();
        const seen = yield* t.git(t.source, ["show", `${nextTurnBaseline}:${APP}`]);
        assert.include(seen, HANAD_LINE);
        assert.equal(yield* t.lineOf(t.source, APP, 15), HANAD_LINE);
      }),
    ),
  );

  const RATIONALE_BLOCK = ["export function rationale() {", '  return "per question";', "}", ""];
  const appliedFeature = (options: { readonly huskyMarker?: string } = {}) =>
    Effect.gen(function* () {
      const t = yield* fixture(options);
      yield* t.editLine(t.source, APP, 2, 'export const v2 = "kousik";');
      const start = yield* t.branchOff();
      yield* t.write(
        t.branch,
        FEATURE,
        ["export const feature = 1;", "", ...RATIONALE_BLOCK].join("\n"),
      );
      yield* t.commitAs(t.branch, HANAD, "Rationale per question");
      const { built } = yield* t.offer(start);
      const result = t.applied(yield* t.apply(start, built.tip));
      assert.deepEqual(result.addedLines, [
        { path: FEATURE, lines: ["export function rationale() {", 'return "per question";'] },
      ]);
      const { hooksDir } = yield* t.lineage.installCreditHook({ cwd: t.source });
      yield* t.lineage.recordCredit({
        cwd: t.source,
        coAuthor: HANAD_COAUTHOR,
        lines: result.addedLines,
      });
      return { t, hooksDir };
    });

  it.live("9. Credit", () =>
    run(
      Effect.gen(function* () {
        const { t, hooksDir } = yield* appliedFeature();
        const gitDir = yield* t.git(t.source, ["rev-parse", "--absolute-git-dir"]);
        assert.isTrue(hooksDir.startsWith(`${gitDir}/`));
        assert.equal(yield* t.git(t.source, ["config", "--get", "core.hooksPath"]), hooksDir);
        assert.equal(
          (yield* t.gitResult(t.clone, ["config", "--local", "--get", "core.hooksPath"])).exitCode,
          1,
        );
        assert.equal(
          (yield* t.gitResult(t.branch, ["config", "--get", "core.hooksPath"])).exitCode,
          1,
        );

        // The git button commits through the server's git.
        yield* t.write(t.source, "notes.md", "# Notes\n\nKousik's note\n");
        yield* t.git(t.source, ["add", "notes.md"]);
        yield* t.git(t.source, ["commit", "--quiet", "-m", "Update notes"]);
        assert.notInclude(yield* t.lastMessage(t.source), "Co-authored-by");

        yield* t.git(t.source, ["add", FEATURE]);
        yield* t.git(t.source, ["commit", "--quiet", "-m", "Add rationale"]);
        assert.include(yield* t.lastMessage(t.source), HANAD_TRAILER);

        assert.deepEqual(yield* t.lineage.pruneCredit({ cwd: t.source }), { remainingLines: 0 });
        assert.isFalse(
          yield* t.fs.exists(t.path.join(gitDir, "pair", "credit.json")).pipe(Effect.orDie),
        );
      }),
    ),
  );

  it.live("9. Credit: an agent's commit with a husky hooks folder", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "lineage-git-husky-" });
        const marker = path.join(outside, "commit-msg-ran");
        const { t } = yield* appliedFeature({ huskyMarker: marker });
        yield* fs.remove(marker, { force: true });

        // An agent runs plain git in its worktree.
        yield* t.git(t.source, ["add", "-A"]);
        yield* t.git(t.source, ["commit", "--quiet", "-m", "Agent commit"]);

        assert.include(yield* t.lastMessage(t.source), HANAD_TRAILER);
        assert.include(yield* fs.readFileString(marker), "commit-msg");
        assert.equal(yield* t.git(t.source, ["status", "--porcelain", "--", ".husky"]), "");
        assert.equal(
          yield* t.git(t.clone, ["config", "--local", "--get", "core.hooksPath"]),
          ".husky",
        );
        assert.equal(yield* t.git(t.branch, ["config", "--get", "core.hooksPath"]), ".husky");
      }),
    ),
  );

  it.live("10. Apply on a busy tree", () =>
    run(
      Effect.gen(function* () {
        const t = yield* fixture();
        const start = yield* t.branchOff();
        yield* t.editLine(t.branch, APP, 15, HANAD_LINE);
        yield* t.commitAs(t.branch, HANAD, "Rationale per question");
        const { built } = yield* t.offer(start);

        yield* t.editLine(t.source, APP, 4, 'export const v4 = "kousik, uncommitted";');
        const otherFile = t.path.join(t.source, OTHER);
        yield* t.fs.utimes(otherFile, 1_000_000_000, 1_000_000_000).pipe(Effect.orDie);
        const otherBefore = yield* t.fs.stat(otherFile).pipe(Effect.orDie);
        const before = {
          head: yield* t.head(t.source),
          index: yield* t.git(t.source, ["ls-files", "--stage"]),
          other: yield* t.read(t.source, OTHER),
        };

        const result = t.applied(yield* t.apply(start, built.tip));
        assert.deepEqual(result.files, [
          { path: APP, status: "modified", additions: 1, deletions: 1 },
        ]);
        assert.equal(yield* t.lineOf(t.source, APP, 4), 'export const v4 = "kousik, uncommitted";');
        assert.equal(yield* t.lineOf(t.source, APP, 15), HANAD_LINE);
        const otherAfter = yield* t.fs.stat(otherFile).pipe(Effect.orDie);
        assert.deepEqual(
          Option.map(otherAfter.mtime, (date) => date.getTime()),
          Option.map(otherBefore.mtime, (date) => date.getTime()),
        );
        assert.deepEqual(
          {
            head: yield* t.head(t.source),
            index: yield* t.git(t.source, ["ls-files", "--stage"]),
            other: yield* t.read(t.source, OTHER),
          },
          before,
        );
      }),
    ),
  );

  it.live("10. Apply on a busy tree: a terminal edit between the check and the write", () =>
    run(
      Effect.gen(function* () {
        const t = yield* fixture();
        const start = yield* t.branchOff();
        yield* t.editLine(t.branch, APP, 15, HANAD_LINE);
        yield* t.commitAs(t.branch, HANAD, "Rationale per question");
        const { built } = yield* t.offer(start);

        let edits = 0;
        const terminalEdit = (times: number) =>
          Effect.suspend(() =>
            ++edits > times
              ? Effect.void
              : t.editLine(t.source, APP, 6, `export const v6 = "terminal ${edits}";`),
          );

        const returned = yield* t.apply(start, built.tip, terminalEdit(Number.POSITIVE_INFINITY));
        assert.deepEqual(returned, { type: "returned", reason: "retries", paths: [APP] });
        assert.equal(edits, 3);
        assert.equal(yield* t.lineOf(t.source, APP, 15), APP_LINES[14]);

        edits = 0;
        t.applied(yield* t.apply(start, built.tip, terminalEdit(1)));
        assert.equal(edits, 2);
        assert.equal(yield* t.lineOf(t.source, APP, 6), 'export const v6 = "terminal 1";');
        assert.equal(yield* t.lineOf(t.source, APP, 15), HANAD_LINE);
      }),
    ),
  );

  it.live("11. Credit doesn't spread", () =>
    run(
      Effect.gen(function* () {
        const { t } = yield* appliedFeature();

        // Stage only a closing brace and blank lines in the credited file, as `git add -p` would.
        const committed = yield* t.git(t.source, ["show", `HEAD:${FEATURE}`]);
        const blob = yield* t.git(t.source, ["hash-object", "-w", "--stdin"], {
          stdin: `${committed}\n}\n\n`,
        });
        yield* t.git(t.source, ["update-index", "--cacheinfo", `100644,${blob},${FEATURE}`]);
        yield* t.git(t.source, ["commit", "--quiet", "-m", "Close a block"]);
        assert.notInclude(yield* t.lastMessage(t.source), "Co-authored-by");

        yield* t.write(t.source, OTHER, 'export const other = 1;\nreturn "per question";\n');
        yield* t.git(t.source, ["add", OTHER]);
        yield* t.git(t.source, ["commit", "--quiet", "-m", "Copy a line elsewhere"]);
        assert.notInclude(yield* t.lastMessage(t.source), "Co-authored-by");

        yield* t.git(t.source, ["add", FEATURE]);
        yield* t.git(t.source, ["commit", "--quiet", "-m", "Add rationale"]);
        assert.include(yield* t.lastMessage(t.source), HANAD_TRAILER);
      }),
    ),
  );
});
