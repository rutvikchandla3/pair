import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type BranchLineage,
  BranchLineageError,
  CommandId,
  EventId,
  MemberId,
  MessageId,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CheckpointService from "../orchestration-v2/CheckpointService.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TeamState from "../team/TeamState.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceHostTesting from "../workspaceHost/WorkspaceHostTesting.ts";
import { lineageTurnNote } from "./LineageAgentNotes.ts";
import * as BranchLineageServiceLive from "./BranchLineageService.ts";
import { BranchLineageService } from "./BranchLineageService.ts";
import * as BranchLineageStepExecutorLive from "./BranchLineageStepExecutorLive.ts";
import * as LineageGit from "./LineageGit.ts";
import { type LineageCaller, LineageRepos } from "./LineageRepos.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const kousik = MemberId.make("member:kousik");
const hanad = MemberId.make("member:hanad");
const meera = MemberId.make("member:meera");
const createdAt = "2026-11-15T10:00:00.000Z";
const member = (id: MemberId, name: string, role: "admin" | "member", isOwner = false) => ({
  id,
  name,
  role,
  gitName: null,
  gitEmail: `${name.toLowerCase()}@example.com`,
  isOwner,
  createdAt,
  updatedAt: null,
  removedAt: null,
});
const as = (memberId: MemberId): LineageCaller => ({ memberId, authorKind: "user" });

const layerDatabase = SqlitePersistence.layerMemory;
const layerPlatform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const layerOrchestration = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "branch-lineage-service" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(BranchLineageStepExecutorLive.layer),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  Layer.provideMerge(
    TeamState.layerTest([
      member(kousik, "Kousik", "admin", true),
      member(hanad, "Hanad", "member"),
      member(meera, "Meera", "admin"),
    ]),
  ),
);
// One clone on one machine: each thread's checkout is its worktree, and nothing needs carrying.
const layerRepos = Layer.effect(
  LineageRepos,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return LineageRepos.of({
      cwdFor: (threadId) =>
        projections.getThread(threadId).pipe(
          Effect.map((thread) => thread.worktreePath ?? ""),
          Effect.mapError(
            () => new BranchLineageError({ reason: "not-found", message: "No checkout." }),
          ),
        ),
      carry: () => Effect.void,
    });
  }),
);
const layerHosts = WorkspaceHostTesting.layerFromContext;
const layerCheckpoints = CheckpointService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      IdAllocator.layer,
      CheckpointStore.layer.pipe(
        Layer.provide(
          VcsDriverRegistry.layer.pipe(
            Layer.provide(VcsProcess.layer),
            Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "lineage-service-" })),
            Layer.provide(layerHosts),
          ),
        ),
      ),
    ),
  ),
  Layer.provide(layerHosts),
);
const layerTest = BranchLineageStepExecutorLive.layerRegister.pipe(
  Layer.provideMerge(BranchLineageServiceLive.layer),
  Layer.provideMerge(
    Layer.mergeAll(layerRepos, LineageGit.layer, layerCheckpoints).pipe(
      Layer.provideMerge(VcsProcess.layer),
      Layer.provideMerge(layerHosts),
    ),
  ),
  Layer.provideMerge(layerOrchestration),
  Layer.provideMerge(layerPlatform),
);

const KOUSIK = { name: "Kousik", email: "kousik@example.com" };
const HANAD = { name: "Hanad", email: "hanad@example.com" };
const APP = "src/app.ts";
const HANAD_LINE = 'export const v15 = "rationale per question";';
const APP_LINES = Array.from(
  { length: 20 },
  (_, index) => `export const v${index + 1} = ${index + 1};`,
);
const sourceId = ThreadId.make("thread:prompt-builder");
const branchId = ThreadId.make("thread:rationale");

/** A source and a branch of it in one clone, as Branch off leaves them. */
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcs = yield* VcsProcess.VcsProcess;
  const lineageGit = yield* LineageGit.LineageGit;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "lineage-service-" }),
  );
  const clone = path.join(root, "clone");
  const source = path.join(root, "prompt-builder");
  const branch = path.join(root, "rationale");
  const git = (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
    vcs
      .run({
        operation: "BranchLineageService.test",
        command: "git",
        cwd,
        args,
        ...(env === undefined ? {} : { env }),
      })
      .pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.orDie,
      );
  const read = (cwd: string, file: string) =>
    fs.readFileString(path.join(cwd, file)).pipe(Effect.orDie);
  const write = (cwd: string, file: string, text: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(path.join(cwd, file)), { recursive: true });
      yield* fs.writeFileString(path.join(cwd, file), text);
    }).pipe(Effect.orDie);
  const editLine = (cwd: string, line: number, text: string) =>
    Effect.gen(function* () {
      const lines = (yield* read(cwd, APP)).split("\n");
      lines[line - 1] = text;
      yield* write(cwd, APP, lines.join("\n"));
    });
  const lineOf = (cwd: string, line: number) =>
    read(cwd, APP).pipe(Effect.map((text) => text.split("\n")[line - 1]));
  const commitAs = (cwd: string, author: LineageGit.LineageAuthor, message: string) =>
    Effect.gen(function* () {
      yield* git(cwd, ["add", "-A"]);
      yield* git(cwd, ["commit", "--quiet", "-m", message], {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
      });
    });

  yield* fs.makeDirectory(clone).pipe(Effect.orDie);
  yield* git(clone, ["init", "--quiet", "--initial-branch=main"]);
  yield* git(clone, ["config", "user.name", "Pair server"]);
  yield* git(clone, ["config", "user.email", "server@example.com"]);
  yield* write(clone, APP, `${APP_LINES.join("\n")}\n`);
  yield* commitAs(clone, KOUSIK, "Initial commit");
  yield* git(clone, ["worktree", "add", "--quiet", "-b", "prompt-builder", source, "main"]);
  yield* editLine(source, 2, 'export const v2 = "kousik draft";');

  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${sourceId}`),
    threadId: sourceId,
    projectId: ProjectId.make("project:pair"),
    title: "Prompt builder",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "prompt-builder",
    worktreePath: source,
    ownerId: kousik,
    createdBy: "user",
    creationSource: "web",
  });
  const start = yield* lineageGit.createSnapshot({
    cwd: source,
    checkpoint: (yield* lineageGit.worktreeTree({ cwd: source })).commit,
    sourceHead: yield* git(source, ["rev-parse", "HEAD"]),
    previousSnapshot: null,
    author: KOUSIK,
    message: "Kousik's work in progress, turn 0",
  });
  yield* lineageGit.addBranchWorktree({
    repoCwd: source,
    worktreePath: branch,
    branch: "rationale",
    startCommit: start,
  });
  const lineage: BranchLineage = {
    branchThreadId: branchId,
    sourceThreadId: sourceId,
    sourceOwnerId: kousik,
    createdAt,
    createdBy: hanad,
    runsOn: "source-machine",
    startFrom: { type: "latest" },
    snapshots: [
      {
        sha: start,
        sourceRunId: null,
        sourceTurn: 0,
        createdAt,
        state: "on-branch",
        mergeCommit: null,
        undoCommit: null,
      },
    ],
    update: null,
    undoableUpdate: null,
    toOffer: { count: 0, commits: [] },
    behind: 0,
    sourceState: "open",
    shipped: null,
    unshipped: 0,
    reverted: null,
    revision: 1,
  };
  yield* orchestrator.dispatch({
    type: "thread.branch-off",
    commandId: CommandId.make(`branch-off:${branchId}`),
    actorId: hanad,
    createdBy: "user",
    creationSource: "web",
    sourceThreadId: sourceId,
    targetThreadId: branchId,
    title: "Rationale per question",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "rationale",
    worktreePath: branch,
    sandboxId: null,
    lineage,
    sourceTurn: 0,
    uncommittedFiles: 1,
  });
  return { source, branch, git, read, write, editLine, lineOf, commitAs };
});

const lineageNotices = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return (yield* orchestrator.getThreadProjection(threadId)).turnItems.flatMap(
      (item: OrchestrationV2TurnItem) =>
        item.type === "system_notice" && item.lineage !== undefined ? [item.lineage] : [],
    );
  });

/** What the thread's next turn would be told, read as the turn start reads it. */
const nextTurnNote = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const runId = RunId.make("run:next");
    const context = yield* projections.getTurnStartContext(threadId, runId);
    return lineageTurnNote({ runId, runs: context.runs, lineage: context.lineage });
  });

const refusal = <A, R>(effect: Effect.Effect<A, BranchLineageError, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

/** Only the lineage step may run: these threads never reach a provider. */
const runSteps = Effect.gen(function* () {
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM orchestration_v2_effect_outbox WHERE effect_type != 'lineage-step.run'`;
  yield* worker.drain();
});

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layerTest> | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(layerTest));

it.live("an offer applies to the source's files between turns, and only its owner applies it", () =>
  run(
    Effect.gen(function* () {
      const t = yield* fixture;
      const service = yield* BranchLineageService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* t.editLine(t.branch, 15, HANAD_LINE);
      yield* t.commitAs(t.branch, HANAD, "Rationale per question");

      const preview = yield* service.offerPreview(as(hanad), { threadId: branchId });
      assert.deepStrictEqual(
        [preview.commits.map((commit) => commit.subject), preview.check, preview.sourceTitle],
        [["Rationale per question"], { clean: true }, "Prompt builder"],
      );
      assert.deepStrictEqual(
        yield* refusal(service.offerCreate(as(kousik), { threadId: branchId })),
        "not-owner",
      );
      const { offer } = yield* service.offerCreate(as(hanad), {
        threadId: branchId,
        note: "Per-question rationale",
      });
      assert.deepStrictEqual(
        [offer.state, offer.senderKind, offer.files.map((file) => file.path), offer.note],
        ["open", "person", [APP], "Per-question rationale"],
      );
      assert.strictEqual((yield* projections.getBranchLineage(branchId))?.toOffer.count, 1);

      // No admin override, and the sender can't apply their own offer to someone else's thread.
      for (const memberId of [meera, hanad]) {
        assert.deepStrictEqual(
          yield* refusal(service.offerApply(as(memberId), { offerId: offer.id })),
          "not-source-owner",
        );
      }
      assert.deepStrictEqual(
        yield* refusal(service.offerWithdraw(as(kousik), { offerId: offer.id })),
        "not-allowed",
      );

      const armed = yield* service.offerApply(as(kousik), { offerId: offer.id });
      assert.isNotNull(armed.offer.armedAt);
      yield* runSteps;

      assert.strictEqual(yield* t.lineOf(t.source, 15), HANAD_LINE);
      assert.strictEqual(yield* t.lineOf(t.source, 2), 'export const v2 = "kousik draft";');
      // Uncommitted: Apply writes no commits.
      assert.strictEqual(yield* t.git(t.source, ["status", "--porcelain"]), `M ${APP}`);
      assert.strictEqual((yield* projections.getOffer(offer.id))?.state, "applied");
      // Applied changes stop counting at once.
      assert.strictEqual((yield* projections.getBranchLineage(branchId))?.toOffer.count, 0);
      const told =
        "Hanad's changes from Rationale per question were applied to your files: 1 file. Credit Hanad when you commit them.";
      assert.deepStrictEqual(
        (yield* lineageNotices(sourceId)).map((notice) => notice.kind),
        ["branched-off", "offer", "agent-told", "applied"],
      );
      assert.deepStrictEqual(yield* nextTurnNote(sourceId), told);
    }),
  ),
);

it.live("decline, withdraw and revert each reach their own state", () =>
  run(
    Effect.gen(function* () {
      const t = yield* fixture;
      const service = yield* BranchLineageService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* t.editLine(t.branch, 15, HANAD_LINE);
      yield* t.commitAs(t.branch, HANAD, "Rationale per question");

      const first = (yield* service.offerCreate(as(hanad), { threadId: branchId })).offer;
      assert.deepStrictEqual(
        yield* refusal(service.offerDecline(as(meera), { offerId: first.id })),
        "not-source-owner",
      );
      const declined = (yield* service.offerDecline(as(kousik), { offerId: first.id })).offer;
      assert.deepStrictEqual([declined.state, declined.decidedBy], ["declined", kousik]);

      // A declined offer can be offered again, and the sender can withdraw it.
      const second = (yield* service.offerCreate(as(hanad), { threadId: branchId })).offer;
      const withdrawn = (yield* service.offerWithdraw(as(hanad), { offerId: second.id })).offer;
      assert.strictEqual(withdrawn.state, "withdrawn");

      const third = (yield* service.offerCreate(as(hanad), { threadId: branchId })).offer;
      yield* service.offerApply(as(kousik), { offerId: third.id });
      yield* runSteps;
      assert.strictEqual(yield* t.lineOf(t.source, 15), HANAD_LINE);

      assert.deepStrictEqual(
        yield* refusal(service.revertOffer(as(hanad), { offerId: third.id })),
        "not-source-owner",
      );
      yield* service.revertOffer(as(kousik), { offerId: third.id });
      yield* runSteps;
      assert.strictEqual(yield* t.lineOf(t.source, 15), "export const v15 = 15;");
      assert.strictEqual(yield* t.lineOf(t.source, 2), 'export const v2 = "kousik draft";');
      const reverted = yield* projections.getOffer(third.id);
      assert.deepStrictEqual([reverted?.state, reverted?.revertedBy], ["applied", kousik]);
      assert.deepStrictEqual((yield* projections.getBranchLineage(branchId))?.reverted, {
        offerId: third.id,
        keptHere: true,
        commits: third.commits.map((commit) => commit.sha),
      });
    }),
  ),
);

it.live("View changes shows only the offer's lines, file by file", () =>
  run(
    Effect.gen(function* () {
      const t = yield* fixture;
      const service = yield* BranchLineageService;
      yield* t.editLine(t.branch, 15, HANAD_LINE);
      yield* t.write(t.branch, "src/rationale.ts", "export const rationale = true;\n");
      yield* t.commitAs(t.branch, HANAD, "Rationale per question");
      const { offer } = yield* service.offerCreate(as(hanad), { threadId: branchId });

      // The source's owner sees it from the card, and the sender from their branch.
      for (const memberId of [kousik, hanad]) {
        const diff = yield* service.offerDiff(as(memberId), { offerId: offer.id });
        assert.deepStrictEqual(
          diff.files.map((file) => [file.path, file.status]),
          [
            [APP, "modified"],
            ["src/rationale.ts", "added"],
          ],
        );
        const [app, added] = diff.files;
        assert.isTrue(app?.patch.startsWith(`diff --git a/${APP} b/${APP}`));
        assert.include(app?.patch, `+${HANAD_LINE}`);
        assert.include(app?.patch, "-export const v15 = 15;");
        // Kousik's own uncommitted draft is the base, never part of Hanad's lines.
        assert.notInclude(app?.patch, "kousik draft");
        assert.include(added?.patch, "+export const rationale = true;");
      }
    }),
  ),
);

it.live("an offer that wouldn't apply cleanly isn't sent", () =>
  run(
    Effect.gen(function* () {
      const t = yield* fixture;
      const service = yield* BranchLineageService;
      yield* t.editLine(t.branch, 15, HANAD_LINE);
      yield* t.commitAs(t.branch, HANAD, "Rationale per question");
      yield* t.editLine(t.source, 15, 'export const v15 = "kousik";');

      const preview = yield* service.offerPreview(as(hanad), { threadId: branchId });
      assert.deepStrictEqual(preview.check, { clean: false, paths: [APP] });
      const error = yield* service.offerCreate(as(hanad), { threadId: branchId }).pipe(Effect.flip);
      assert.deepStrictEqual(
        [error.reason, error.message],
        ["would-conflict", "Update from Prompt builder first."],
      );
      assert.deepStrictEqual(
        yield* refusal(
          (yield* BranchLineageService).offerCreate(as(hanad), { threadId: sourceId }),
        ),
        "not-found",
      );
    }),
  ),
);

it.live("a clean Update merges the source's work, tells the agent, and can be undone", () =>
  run(
    Effect.gen(function* () {
      const t = yield* fixture;
      const service = yield* BranchLineageService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* t.editLine(t.branch, 15, HANAD_LINE);
      yield* t.commitAs(t.branch, HANAD, "Rationale per question");
      yield* t.editLine(t.source, 2, 'export const v2 = "kousik final";');
      yield* t.editLine(t.source, 8, 'export const v8 = "kousik";');

      assert.deepStrictEqual(
        yield* refusal(service.update(as(kousik), { threadId: branchId, onConflict: "self" })),
        "not-owner",
      );
      const preview = yield* service.updatePreview(as(hanad), { threadId: branchId });
      assert.deepStrictEqual(
        [preview.files, preview.conflicts],
        [[{ path: APP, status: "clean" }], []],
      );
      const result = yield* service.update(as(hanad), { threadId: branchId, onConflict: "self" });
      assert.deepStrictEqual(result, { result: "merged", files: 1, conflicts: [] });
      assert.deepStrictEqual(
        [yield* t.lineOf(t.branch, 2), yield* t.lineOf(t.branch, 8), yield* t.lineOf(t.branch, 15)],
        ['export const v2 = "kousik final";', 'export const v8 = "kousik";', HANAD_LINE],
      );
      const updated = (yield* projections.getBranchLineage(branchId))!;
      assert.deepStrictEqual(
        [
          updated.snapshots.map((snapshot) => snapshot.state),
          updated.update,
          updated.toOffer.count,
        ],
        [["on-branch", "on-branch"], null, 1],
      );
      assert.isNotNull(updated.undoableUpdate);
      assert.deepStrictEqual(
        (yield* lineageNotices(branchId)).map((notice) => notice.kind),
        ["branched-from", "updated", "agent-told"],
      );
      assert.strictEqual(
        yield* nextTurnNote(branchId),
        `Prompt builder was merged into your branch: 1 file changed: ${APP}.`,
      );

      yield* service.undoUpdate(as(hanad), { threadId: branchId });
      assert.deepStrictEqual(
        [yield* t.lineOf(t.branch, 2), yield* t.lineOf(t.branch, 15)],
        ['export const v2 = "kousik draft";', HANAD_LINE],
      );
      const undone = (yield* projections.getBranchLineage(branchId))!;
      assert.deepStrictEqual(
        [undone.snapshots.map((snapshot) => snapshot.state), undone.undoableUpdate],
        [["on-branch", "undone"], null],
      );
      assert.deepStrictEqual(
        yield* refusal(service.undoUpdate(as(hanad), { threadId: branchId })),
        "not-allowed",
      );
      // The next Update brings everything back.
      yield* service.update(as(hanad), { threadId: branchId, onConflict: "self" });
      assert.strictEqual(yield* t.lineOf(t.branch, 2), 'export const v2 = "kousik final";');
    }),
  ),
);

it.live("a conflicted Update stays open until resolved, refuses Offer, and aborts cleanly", () =>
  run(
    Effect.gen(function* () {
      const t = yield* fixture;
      const service = yield* BranchLineageService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* t.editLine(t.branch, 2, 'export const v2 = "hanad";');
      yield* t.commitAs(t.branch, HANAD, "Hanad's v2");
      const before = yield* t.git(t.branch, ["rev-parse", "HEAD"]);
      yield* t.editLine(t.source, 2, 'export const v2 = "kousik final";');

      const preview = yield* service.updatePreview(as(hanad), { threadId: branchId });
      assert.deepStrictEqual(preview.conflicts, [APP]);
      const conflicted = yield* service.update(as(hanad), {
        threadId: branchId,
        onConflict: "self",
      });
      assert.deepStrictEqual(conflicted, { result: "conflicted", files: 1, conflicts: [APP] });
      assert.deepStrictEqual(
        (yield* projections.getBranchLineage(branchId))?.update?.conflictedPaths,
        [APP],
      );
      assert.deepStrictEqual(
        yield* refusal(service.offerCreate(as(hanad), { threadId: branchId })),
        "update-open",
      );
      assert.deepStrictEqual(
        yield* refusal(service.update(as(hanad), { threadId: branchId, onConflict: "self" })),
        "update-open",
      );

      yield* service.abortUpdate(as(hanad), { threadId: branchId });
      assert.strictEqual(yield* t.git(t.branch, ["rev-parse", "HEAD"]), before);
      assert.strictEqual(yield* t.git(t.branch, ["status", "--porcelain"]), "");
      const aborted = (yield* projections.getBranchLineage(branchId))!;
      assert.deepStrictEqual(
        [aborted.update, aborted.snapshots.map((snapshot) => snapshot.state)],
        [null, ["on-branch", "aborted"]],
      );

      // "Let my agent resolve it": a turn on the branch, which here leaves markers behind.
      const agent = yield* service.update(as(hanad), { threadId: branchId, onConflict: "agent" });
      assert.strictEqual(agent.result, "conflicted");
      const messages = (yield* orchestrator.getThreadProjection(branchId)).messages;
      assert.isTrue(
        messages.some((message) =>
          message.text.startsWith(
            `Resolve the conflict markers from the update from Prompt builder in: ${APP}.`,
          ),
        ),
      );
      yield* t.commitAs(t.branch, HANAD, "Merge with markers");
      yield* service.afterCheckpoint(branchId);
      assert.deepStrictEqual(
        (yield* projections.getBranchLineage(branchId))?.update?.conflictedPaths,
        [APP],
      );
      assert.deepStrictEqual(
        yield* refusal(service.offerPreview(as(hanad), { threadId: branchId })),
        "update-open",
      );
      assert.strictEqual(
        yield* nextTurnNote(branchId),
        `An update from Prompt builder is in progress. These files have conflict markers: ${APP}. Resolve them and commit; don't abort or stash the merge.`,
      );

      // Resolved and committed: the Update completes, and Undo waits for the next turn.
      yield* t.editLine(t.branch, 2, 'export const v2 = "both";');
      const text = yield* t.read(t.branch, APP);
      yield* t.write(
        t.branch,
        APP,
        text
          .split("\n")
          .filter(
            (line) =>
              !/^(<{7}|={7}|>{7})/.test(line) &&
              !line.includes('"kousik final"') &&
              !line.includes('"hanad"'),
          )
          .join("\n"),
      );
      yield* t.commitAs(t.branch, HANAD, "Resolve the update");
      yield* service.afterCheckpoint(branchId);
      const resolved = (yield* projections.getBranchLineage(branchId))!;
      assert.strictEqual(resolved.update, null);
      assert.strictEqual(resolved.snapshots.at(-1)?.state, "on-branch");
      assert.isNotNull(resolved.undoableUpdate);
      // The branch's next turn ends Undo update.
      yield* service.afterCheckpoint(branchId);
      assert.isNull((yield* projections.getBranchLineage(branchId))?.undoableUpdate);
    }),
  ),
);

it.live("an Apply armed during a turn runs at its boundary", () =>
  run(
    Effect.gen(function* () {
      const t = yield* fixture;
      const service = yield* BranchLineageService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      yield* t.editLine(t.branch, 15, HANAD_LINE);
      yield* t.commitAs(t.branch, HANAD, "Rationale per question");
      const { offer } = yield* service.offerCreate(as(hanad), { threadId: branchId });

      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("send:turn"),
        threadId: sourceId,
        messageId: MessageId.make("message:turn"),
        text: "Keep going",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* sql`DELETE FROM orchestration_v2_effect_outbox`;
      const armed = yield* service.offerApply(as(kousik), { offerId: offer.id });
      assert.isNotNull(armed.offer.armedAt);
      assert.strictEqual((yield* projections.getLineageStep(sourceId))?.state, "armed");
      yield* runSteps;
      assert.strictEqual(yield* t.lineOf(t.source, 15), "export const v15 = 15;");

      const active = (yield* orchestrator.getThreadProjection(sourceId)).runs.find(
        (candidate) => candidate.status === "starting" || candidate.status === "running",
      )!;
      const afterSequence = yield* eventSink.latestSequence();
      const endedAt = yield* DateTime.now;
      yield* eventSink.writeWithEffects({
        events: [
          {
            id: EventId.make("event:turn-ended"),
            type: "run.updated",
            threadId: sourceId,
            runId: active.id,
            occurredAt: endedAt,
            payload: { ...active, status: "completed", completedAt: endedAt },
          },
        ],
        effects: [],
      });
      yield* eventSink.stream({ afterSequence, eventType: "thread.lineage-step.updated" }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "thread.lineage-step.updated" &&
            stored.event.payload.step?.state === "running",
        ),
        Stream.runHead,
      );
      yield* runSteps;
      assert.strictEqual(yield* t.lineOf(t.source, 15), HANAD_LINE);
      assert.strictEqual((yield* projections.getOffer(offer.id))?.state, "applied");
      assert.isNull(yield* projections.getLineageStep(sourceId));
    }),
  ),
);

it.live("a branch follows its source's state, and a deleted source's offers are withdrawn", () =>
  run(
    Effect.gen(function* () {
      const t = yield* fixture;
      const service = yield* BranchLineageService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* t.editLine(t.branch, 15, HANAD_LINE);
      yield* t.commitAs(t.branch, HANAD, "Rationale per question");
      const { offer } = yield* service.offerCreate(as(hanad), { threadId: branchId });

      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive:source"),
        threadId: sourceId,
      });
      yield* service.sourceChanged(sourceId);
      assert.strictEqual((yield* projections.getBranchLineage(branchId))?.sourceState, "archived");
      // Open offers wait while the source is archived.
      assert.strictEqual((yield* projections.getOffer(offer.id))?.state, "open");

      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete:source"),
        threadId: sourceId,
      });
      yield* service.sourceChanged(sourceId);
      assert.strictEqual((yield* projections.getBranchLineage(branchId))?.sourceState, "deleted");
      assert.strictEqual((yield* projections.getOffer(offer.id))?.state, "withdrawn");
      assert.deepStrictEqual(
        yield* refusal(service.update(as(hanad), { threadId: branchId, onConflict: "self" })),
        "source-unavailable",
      );
    }),
  ),
);
