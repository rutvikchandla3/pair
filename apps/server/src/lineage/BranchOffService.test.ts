import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  ComputeDriverId,
  EventId,
  type LineageNotice,
  MemberId,
  NodeId,
  type OrchestrationV2Sandbox,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  SandboxId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { threadSlotEnvironment } from "../sandbox/credentials/SandboxProcessEnvironment.ts";
import { SandboxWake } from "../sandbox/lifecycle/SandboxWakeService.ts";
import * as CheckpointMirror from "../sandbox/mirror/CheckpointMirror.ts";
import * as MirrorSync from "../sandbox/mirror/MirrorSync.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TeamState from "../team/TeamState.ts";
import * as ThreadAccess from "../team/ThreadAccess.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceHostLoopback from "../workspaceHost/WorkspaceHostLoopback.ts";
import { BranchOffService } from "./BranchOffService.ts";
import * as BranchOffServiceLive from "./BranchOffServiceLive.ts";
import * as RecordingSteps from "./BranchLineageStepExecutor.testkit.ts";
import * as LineageGit from "./LineageGit.ts";
import type { LineageCaller } from "./LineageRepos.ts";

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const kousik = MemberId.make("member:kousik");
const hanad = MemberId.make("member:hanad");
const rutvik = MemberId.make("member:rutvik");
const person = (memberId: MemberId): LineageCaller => ({ memberId, authorKind: "user" });
const projectId = ProjectId.make("project:pair-be");
const sourceId = ThreadId.make("thread:prompt-builder");
const machine = SandboxId.make("sbx_00000000000000000a11");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const driverId = ComputeDriverId.make("docker");
const checkpointRef = CheckpointRef.make(
  "refs/t3/orchestration-v2/checkpoints/cHJvbXB0LWJ1aWxkZXI/ordinal/7",
);

class Root extends Context.Service<Root, string>()("t3/lineage/BranchOffService.test/Root") {}

/** What the launch and wake seams were asked to do. */
class Seams extends Context.Service<
  Seams,
  {
    readonly prepared: Ref.Ref<ReadonlyArray<string>>;
    readonly woken: Ref.Ref<ReadonlyArray<string>>;
  }
>()("t3/lineage/BranchOffService.test/Seams") {}

const layerSeams = Layer.effect(
  Seams,
  Effect.all({
    prepared: Ref.make<ReadonlyArray<string>>([]),
    woken: Ref.make<ReadonlyArray<string>>([]),
  }),
);

const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestration = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      ProjectStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "branch-off" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        // Only a cloud-only server starts machines.
        { databaseLayer: layerDatabase, runEffectWorker: false, cloudOnly: true },
      ),
    ),
  ),
  Layer.provideMerge(RecordingSteps.layerRecording),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

/** The machine is a folder under one loopback root, so git there runs through a real runner. */
const layerHosts = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "branch-off-" }));
    return Layer.merge(WorkspaceHostLoopback.layerLoopback(root), Layer.succeed(Root, root));
  }),
);

const member = (id: MemberId, name: string, gitEmail: string | null) => ({
  id,
  name,
  role: "member" as const,
  gitName: null,
  gitEmail,
  isOwner: id === kousik,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: null,
  removedAt: null,
});

const layerService = BranchOffServiceLive.layer.pipe(
  // Kousik's machine: open to him and Hanad, not Rutvik.
  Layer.provide(
    ThreadAccess.layerTest({
      serverOwnerId: kousik,
      machines: new Map([
        [machine, { ownerMemberId: kousik, audience: "members", memberIds: new Set([hanad]) }],
      ]),
    }),
  ),
  Layer.provide(
    Layer.effect(
      ThreadLaunch.ThreadLaunchService,
      Effect.gen(function* () {
        const seams = yield* Seams;
        return ThreadLaunch.ThreadLaunchService.of({
          checkCloudLaunch: () =>
            Effect.succeed({ driverId, size: "default" as const, imageBuild: null }),
          prepareRun: (input: ThreadLaunch.ThreadLaunchPreparationInput) =>
            Ref.update(seams.prepared, (runs) => [...runs, input.runId]),
        } as never);
      }),
    ),
  ),
  Layer.provide(
    Layer.effect(
      SandboxWake,
      Effect.map(Effect.service(Seams), (seams) =>
        SandboxWake.of({
          wake: ({ threadId }) => Ref.update(seams.woken, (woken) => [...woken, threadId]),
          viewed: () => Effect.void,
        }),
      ),
    ),
  ),
  Layer.provide(
    Layer.mock(TextGeneration.TextGeneration)({
      generatePrContent: (input) =>
        Effect.succeed({
          title: "unused",
          body: `## Where it stands\n\n${input.threadContext?.includes("rationale") ? "Rationale is next." : "?"}\n`,
        }),
    }),
  ),
  Layer.provideMerge(
    TeamState.layerTest([
      member(kousik, "Kousik Rao", "kousik@example.com"),
      member(hanad, "Hanad Ali", null),
      member(rutvik, "Rutvik", null),
    ]),
  ),
  Layer.provideMerge(MirrorSync.layer),
  Layer.provideMerge(Layer.mergeAll(LineageGit.layer, CheckpointMirror.layer, IdAllocator.layer)),
  Layer.provideMerge(Layer.mergeAll(GitVcsDriver.layer, VcsProcess.layer)),
  Layer.provideMerge(layerOrchestration),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "branch-off-test-" })),
  Layer.provideMerge(layerHosts),
  Layer.provideMerge(layerSeams),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const git = Effect.fn("BranchOffTest.git")(function* (cwd: string, args: ReadonlyArray<string>) {
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const result = yield* driver.execute({
    operation: "BranchOffTest.git",
    cwd,
    args,
    env: GIT_IDENTITY,
    allowNonZeroExit: true,
  });
  return result.stdout.trim();
});

const sandboxRecord = (
  overrides: Partial<OrchestrationV2Sandbox> = {},
): OrchestrationV2Sandbox => ({
  id: machine,
  projectId,
  ownerThreadId: sourceId,
  ownerMemberId: kousik,
  driverId,
  size: "default",
  state: "ready",
  generation: 1,
  driverRef: "ref",
  admission: null,
  runnerLostAt: null,
  sleepReason: null,
  failure: null,
  access: {
    audience: "members",
    memberIds: [hanad],
    updatedBy: kousik,
    updatedAt: DateTime.makeUnsafe(0),
  },
  createdAt: DateTime.makeUnsafe(0),
  updatedAt: DateTime.makeUnsafe(0),
  ...overrides,
});

const setMachine = (overrides: Partial<OrchestrationV2Sandbox> = {}) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* projections.apply({
      id: EventId.make(`event:machine:${overrides.state ?? "ready"}`),
      type: "sandbox.updated",
      threadId: sourceId,
      occurredAt: DateTime.makeUnsafe(0),
      payload: sandboxRecord(overrides),
    });
  });

/**
 * Kousik's Prompt builder on his machine: a clone of the project with his worktree, one commit
 * of his own and uncommitted work, captured as turn 7's checkpoint (also in the mirror).
 */
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const sql = yield* SqlClient.SqlClient;
  const root = yield* Root;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const lineageGit = yield* LineageGit.LineageGit;
  const project = yield* fs.makeTempDirectoryScoped({ prefix: "branch-off-project-" });
  yield* git(project, ["init", "--quiet", "--initial-branch=main"]);
  yield* fs.writeFileString(`${project}/schema.ts`, "export const schema = 1;\n");
  yield* git(project, ["add", "."]);
  yield* git(project, ["commit", "--quiet", "-m", "Initial"]);
  yield* git(project, ["update-ref", "refs/remotes/origin/HEAD", "HEAD"]);
  yield* git(project, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json,
      scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${projectId}, 'pair-be', ${project}, NULL,
      '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
    )
  `;
  const clone = `${root}/${machine}/repos/pair-be`;
  const sourceCwd = `${root}/${machine}/worktrees/kousik-prompt-builder`;
  yield* git(project, ["clone", "--quiet", "--no-local", project, clone]);
  yield* git(clone, ["worktree", "add", "--quiet", "-b", "kousik/prompt-builder", sourceCwd]);
  yield* fs.writeFileString(`${sourceCwd}/builder.ts`, "export const builder = 1;\n");
  yield* git(sourceCwd, ["add", "."]);
  yield* git(sourceCwd, ["commit", "--quiet", "-m", "Prompt builder"]);
  const sourceHead = yield* git(sourceCwd, ["rev-parse", "HEAD"]);
  // Agents leave turns uncommitted; the checkpoint holds them.
  yield* fs.writeFileString(`${sourceCwd}/builder.ts`, "export const builder = 2;\n");
  yield* fs.writeFileString(`${sourceCwd}/rationale.md`, "draft\n");
  const tree = yield* lineageGit.worktreeTree({ cwd: sourceCwd });
  yield* git(sourceCwd, ["update-ref", checkpointRef, tree.commit]);

  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${sourceId}`),
    threadId: sourceId,
    projectId,
    title: "Prompt builder",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "kousik/prompt-builder",
    worktreePath: sourceCwd,
    ownerId: kousik,
    createdBy: "user",
    creationSource: "web",
  });
  const thread = yield* projections.getThread(sourceId);
  yield* projections.apply({
    id: EventId.make("event:source-machine"),
    type: "thread.metadata-updated",
    threadId: sourceId,
    occurredAt: thread.createdAt,
    payload: { ...thread, sandboxId: machine },
  });
  yield* setMachine();
  yield* projections.apply({
    id: EventId.make("event:checkpoint-7"),
    type: "checkpoint.captured",
    threadId: sourceId,
    occurredAt: thread.createdAt,
    payload: {
      id: CheckpointId.make("checkpoint:7"),
      threadId: sourceId,
      scopeId: CheckpointScopeId.make("scope:prompt-builder"),
      runId: RunId.make("run:7"),
      nodeId: NodeId.make("node:7"),
      parentCheckpointId: null,
      ordinalWithinScope: 7,
      appRunOrdinal: 7,
      ref: checkpointRef,
      status: "ready",
      files: [{ path: "builder.ts", kind: "modified", additions: 1, deletions: 1 }] as never,
      capturedAt: thread.createdAt,
    },
  });
  return { project, clone, sourceCwd, sourceHead, checkpoint: tree };
});

const branchOff = (
  overrides: Partial<Parameters<BranchOffService["Service"]["branchOff"]>[1]> = {},
  caller: LineageCaller = person(hanad),
) =>
  BranchOffService.use((service) =>
    service.branchOff(caller, {
      sourceThreadId: sourceId,
      runsOn: "source-machine",
      startFrom: { type: "latest" },
      branch: "hanad/rationale",
      prompt: "Add a rationale per question",
      contextSummary: "Kousik built the prompt builder.",
      ...overrides,
    }),
  );

const lineageNotices = (threadId: ThreadId) =>
  ThreadManagementService.ThreadManagementService.use((threads) =>
    threads.getThreadProjection(threadId),
  ).pipe(
    Effect.map((projection) =>
      projection.turnItems.flatMap((item) =>
        item.type === "system_notice" && item.lineage !== undefined
          ? [item.lineage as LineageNotice]
          : [],
      ),
    ),
  );

describe("BranchOffService", () => {
  it.effect(
    "branches off on the source's machine: a worktree at the snapshot, Hanad's own thread",
    () =>
      Effect.gen(function* () {
        const { sourceCwd, sourceHead, checkpoint } = yield* setup;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const threads = yield* ThreadManagementService.ThreadManagementService;

        const draft = yield* BranchOffService.use((service) =>
          service.draft(person(hanad), { sourceThreadId: sourceId }),
        );
        assert.deepInclude(draft, {
          allowed: true,
          sourceTitle: "Prompt builder",
          sourceOwnerId: kousik,
          busy: false,
          suggestedBranch: "hanad/prompt-builder",
        });
        assert.deepStrictEqual(draft.latestTurn.turn, 7);
        assert.deepStrictEqual(draft.machine, { state: "ready", working: 0, ownerId: kousik });
        assert.deepStrictEqual(draft.audience, [kousik, hanad]);

        const { threadId } = yield* branchOff();
        const branch = yield* projections.getThread(threadId);
        const worktree = sourceCwd.replace("kousik-prompt-builder", "hanad-rationale");
        assert.deepStrictEqual(
          [branch.ownerId, branch.sandboxId, branch.branch, branch.worktreePath],
          [hanad, machine, "hanad/rationale", worktree],
        );

        // The snapshot: the checkpoint's tree on Kousik's HEAD, authored as him.
        const [head, parents, tree, author, subject] = (yield* git(worktree, [
          "show",
          "-s",
          "--format=%H%n%P%n%T%n%an <%ae>%n%s",
          "HEAD",
        ])).split("\n");
        assert.deepStrictEqual([parents, tree], [sourceHead, checkpoint.tree]);
        assert.deepStrictEqual(
          [author, subject],
          ["Kousik Rao <kousik@example.com>", "Kousik's work in progress, turn 7"],
        );
        assert.equal(yield* git(worktree, ["show", "HEAD:rationale.md"]), "draft");
        const lineage = yield* projections.getBranchLineage(threadId);
        assert.deepStrictEqual(
          [lineage?.runsOn, lineage?.snapshots.map((snapshot) => snapshot.sha), lineage?.revision],
          ["source-machine", [head], 2],
        );

        // It joins the machine with its own slot, so its own PORT.
        assert.sameMembers(
          (yield* projections.listSandboxThreads(machine)).map((row) => row.threadId),
          [sourceId, threadId],
        );
        const slot = yield* projections.slotFor(threadId);
        assert.deepStrictEqual(threadSlotEnvironment(slot), {
          PAIR_THREAD_SLOT: "1",
          PORT: "3001",
        });

        // Its first instructions say the database is shared, and the first message is Hanad's.
        const notices = yield* lineageNotices(threadId);
        assert.deepStrictEqual(
          notices.map((notice) => notice.kind),
          ["branched-from", "agent-told"],
        );
        const projection = yield* threads.getThreadProjection(threadId);
        assert.deepStrictEqual(
          projection.messages.map((message) => message.text),
          ["Kousik built the prompt builder.\n\nAdd a rationale per question"],
        );
        assert.equal(projection.runs.length, 1);
        // The source is never touched.
        assert.equal(yield* git(sourceCwd, ["rev-parse", "HEAD"]), sourceHead);
        assert.equal(
          yield* git(sourceCwd, ["status", "--porcelain"]),
          "M builder.ts\n?? rationale.md",
        );
      }).pipe(Effect.provide(layerService), Effect.scoped),
  );

  it.effect(
    "branches off onto a new machine seeded from the mirror, with the source's audience",
    () =>
      Effect.gen(function* () {
        const { checkpoint } = yield* setup;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const mirror = yield* CheckpointMirror.CheckpointMirror;
        const seams = yield* Seams;

        const { threadId } = yield* branchOff({ runsOn: "new-machine" });

        const branchRef = CheckpointMirror.sandboxBranchRef(threadId);
        const seedRef = CheckpointMirror.sandboxSeedRef(threadId);
        const tips = yield* mirror.tips(projectId, [branchRef, seedRef]);
        const snapshot = tips.get(branchRef)!;
        assert.equal(tips.get(seedRef), snapshot);
        const gitDir = mirror.gitDir(projectId);
        assert.deepStrictEqual(
          (yield* git(gitDir, [
            `--git-dir=${gitDir}`,
            "show",
            "-s",
            "--format=%T%n%an%n%s",
            snapshot,
          ])).split("\n"),
          [checkpoint.tree, "Kousik Rao", "Kousik's work in progress, turn 7"],
        );

        const branch = yield* projections.getThread(threadId);
        assert.isDefined(branch.sandboxId);
        assert.notEqual(branch.sandboxId, machine);
        const record = yield* projections.getSandbox(branch.sandboxId!);
        assert.deepStrictEqual(
          [record?.state, record?.ownerMemberId, record?.ownerThreadId, record?.access?.memberIds],
          ["provisioning", hanad, threadId, [kousik]],
        );
        const { runs } = yield* ThreadManagementService.ThreadManagementService.use((threads) =>
          threads.getThreadRecords(threadId, ["runs"]),
        );
        assert.deepStrictEqual(
          runs.map((run) => [run.status, run.workspacePreparation?.type]),
          [["preparing", "worktree"]],
        );
        assert.deepStrictEqual(yield* Ref.get(seams.prepared), [runs[0]!.id]);
        assert.equal((yield* projections.getBranchLineage(threadId))?.runsOn, "new-machine");
        // Nothing on a new machine is shared, so nothing is told about it.
        assert.deepStrictEqual(
          (yield* lineageNotices(threadId)).map((notice) => notice.kind),
          ["branched-from"],
        );
      }).pipe(Effect.provide(layerService), Effect.scoped),
  );

  it.effect(
    "refuses quietly: no access, a branch, a local thread, an agent, a failed machine",
    () =>
      Effect.gen(function* () {
        yield* setup;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const reasonOf = <A, R>(effect: Effect.Effect<A, { readonly reason: string | null }, R>) =>
          effect.pipe(
            Effect.flip,
            Effect.map((error) => error.reason),
          );

        assert.equal(yield* reasonOf(branchOff({}, person(rutvik))), "not-found");
        assert.equal(
          yield* reasonOf(branchOff({}, { memberId: hanad, authorKind: "agent" })),
          "not-allowed",
        );

        const { threadId } = yield* branchOff();
        assert.equal(
          yield* reasonOf(branchOff({ sourceThreadId: threadId, branch: "hanad/again" })),
          "branch-of-branch",
        );
        const draft = yield* BranchOffService.use((service) =>
          service.draft(person(hanad), { sourceThreadId: threadId }),
        );
        assert.deepInclude(draft, { allowed: false, reason: "branch-of-branch" });

        const localId = ThreadId.make("thread:local");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create:local"),
          threadId: localId,
          projectId,
          title: "Local",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          ownerId: hanad,
          createdBy: "user",
          creationSource: "web",
        });
        assert.equal(
          yield* reasonOf(branchOff({ sourceThreadId: localId, branch: "hanad/local" })),
          "not-cloud",
        );

        yield* setMachine({ state: "failed" });
        assert.equal(yield* reasonOf(branchOff({ branch: "hanad/failed" })), "machine-gone");
      }).pipe(Effect.provide(layerService), Effect.scoped),
  );

  it.effect("moves a branch to its own machine: membership moves, the old worktree goes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* setup;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const mirror = yield* CheckpointMirror.CheckpointMirror;
      const { threadId } = yield* branchOff({ prompt: "", contextSummary: "" });
      const before = yield* projections.getThread(threadId);
      const oldPath = before.worktreePath!;
      yield* fs.writeFileString(`${oldPath}/notes.md`, "uncommitted\n");

      // The machine's owning thread is already on its own machine.
      const refusal = yield* BranchOffService.use((service) =>
        service.moveToOwnMachine(person(kousik), { threadId: sourceId }),
      ).pipe(Effect.flip);
      assert.equal(refusal.reason, "not-allowed");

      yield* BranchOffService.use((service) =>
        service.moveToOwnMachine(person(hanad), { threadId }),
      );

      const after = yield* projections.getThread(threadId);
      assert.isDefined(after.sandboxId);
      assert.notEqual(after.sandboxId, machine);
      assert.notEqual(after.worktreePath, oldPath);
      assert.deepStrictEqual(
        (yield* projections.listSandboxThreads(machine)).map((row) => row.threadId),
        [sourceId],
      );
      assert.deepStrictEqual(
        (yield* projections.listSandboxThreads(after.sandboxId!)).map((row) => row.threadId),
        [threadId],
      );
      const record = yield* projections.getSandbox(after.sandboxId!);
      assert.deepStrictEqual([record?.ownerMemberId, record?.state], [hanad, "provisioning"]);
      assert.isFalse(yield* fs.exists(oldPath));
      assert.equal((yield* projections.getBranchLineage(threadId))?.runsOn, "new-machine");
      const moved = (yield* lineageNotices(threadId)).find(
        (notice) => notice.kind === "moved-machine",
      );
      assert.deepStrictEqual(moved, { kind: "moved-machine", actorId: hanad });
      // The new machine's checkout picks up exactly here: its branch, and the uncommitted file.
      const refs = [
        CheckpointMirror.sandboxBranchRef(threadId),
        CheckpointMirror.sandboxSnapshotRef(threadId),
        CheckpointMirror.sandboxSeedRef(threadId),
      ];
      const tips = yield* mirror.tips(projectId, refs);
      assert.equal(tips.size, 3);
      const gitDir = mirror.gitDir(projectId);
      assert.equal(
        yield* git(gitDir, [`--git-dir=${gitDir}`, "show", `${tips.get(refs[1]!)}:notes.md`]),
        "uncommitted",
      );
    }).pipe(Effect.provide(layerService), Effect.scoped),
  );

  it.effect(
    "starts from main with a shipped branch's own commits, then moves it off the source's machine",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { project } = yield* setup;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const { threadId } = yield* branchOff({ prompt: "", contextSummary: "" });
        const cwd = (yield* projections.getThread(threadId)).worktreePath!;
        yield* fs.writeFileString(`${cwd}/answer.ts`, "export const answer = 42;\n");
        yield* git(cwd, ["add", "answer.ts"]);
        yield* git(cwd, ["commit", "--quiet", "-m", "Answer"]);
        const mine = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* fs.writeFileString(`${cwd}/scratch.md`, "still mine\n");
        // Main moved on after the source's PR merged.
        yield* fs.writeFileString(`${project}/readme.md`, "merged\n");
        yield* git(project, ["add", "."]);
        yield* git(project, ["commit", "--quiet", "-m", "Merge prompt builder"]);
        const main = yield* git(project, ["rev-parse", "HEAD"]);

        const lineage = (yield* projections.getBranchLineage(threadId))!;
        yield* orchestrator.dispatch({
          type: "thread.branch-lineage.record",
          commandId: CommandId.make("shipped"),
          threadId,
          lineage: {
            ...lineage,
            toOffer: { count: 1, commits: [mine] },
            sourceState: "shipped",
            shipped: {
              url: "https://github.com/t3/pair-be/pull/482",
              number: 482,
              label: "pair-be#482",
            },
            unshipped: 1,
            revision: lineage.revision + 1,
          },
        });

        const result = yield* BranchOffService.use((service) =>
          service.startFromMain(person(hanad), { threadId }),
        );
        assert.deepStrictEqual(result, { base: "main", commits: 1, movedMachine: true });
        // It left the source's machine, so its new checkout comes from the mirror: only Hanad's
        // commit on main, Kousik's snapshot gone, and the uncommitted file still uncommitted.
        assert.isFalse(yield* fs.exists(cwd));
        const mirror = yield* CheckpointMirror.CheckpointMirror;
        const gitDir = mirror.gitDir(projectId);
        const inMirror = (args: ReadonlyArray<string>) =>
          git(gitDir, [`--git-dir=${gitDir}`, ...args]);
        const branchRef = CheckpointMirror.sandboxBranchRef(threadId);
        const snapshotRef = CheckpointMirror.sandboxSnapshotRef(threadId);
        assert.equal(yield* inMirror(["rev-parse", `${branchRef}^`]), main);
        assert.equal(yield* inMirror(["log", "--format=%s", `${main}..${branchRef}`]), "Answer");
        assert.equal(
          yield* inMirror(["show", `${branchRef}:answer.ts`]),
          "export const answer = 42;",
        );
        assert.equal(yield* inMirror(["show", `${snapshotRef}:scratch.md`]), "still mine");
        const detached = yield* projections.getBranchLineage(threadId);
        assert.deepStrictEqual(
          [detached?.toOffer.count, detached?.sourceState, detached?.detachedAt !== undefined],
          [0, "shipped", true],
        );
        const shell = yield* projections.getThreadShell(threadId);
        assert.isNull(shell?.branchLink?.source ?? null);
        assert.notEqual((yield* projections.getThread(threadId)).sandboxId, machine);
      }).pipe(Effect.provide(layerService), Effect.scoped),
  );

  it.effect("writes the context summary on the caller's account", () =>
    Effect.gen(function* () {
      yield* setup;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("source:message"),
        threadId: sourceId,
        messageId: "message:source" as never,
        text: "Next we need a rationale per question.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
        actorId: kousik,
      });
      const summary = yield* BranchOffService.use((service) =>
        service.summary(person(hanad), { sourceThreadId: sourceId, modelSelection }),
      );
      assert.equal(summary.text, "## Where it stands\n\nRationale is next.");
    }).pipe(Effect.provide(layerService), Effect.scoped),
  );
});
