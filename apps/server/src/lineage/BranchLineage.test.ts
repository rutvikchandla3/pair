import { assert, it } from "@effect/vitest";
import {
  type BranchLineage,
  CommandId,
  EventId,
  MemberId,
  MessageId,
  type Offer,
  OfferId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SandboxId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import {
  overlayForViewer,
  type ThreadViewer,
  type ViewerAccess,
} from "../orchestration-v2/MemberThreadView.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as RecordingSteps from "./BranchLineageStepExecutor.testkit.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "branch-lineage" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(RecordingSteps.layerRecording),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

const kousik = MemberId.make("member:kousik");
const hanad = MemberId.make("member:hanad");
const sourceId = ThreadId.make("thread:prompt-builder");
const sandboxId = SandboxId.make("sbx_0123456789abcdef0123");
const createdAt = "2026-11-15T10:00:00.000Z";

const lineageOf = (branchThreadId: ThreadId, overrides: Partial<BranchLineage> = {}) =>
  ({
    branchThreadId,
    sourceThreadId: sourceId,
    sourceOwnerId: kousik,
    createdAt,
    createdBy: hanad,
    runsOn: "source-machine",
    startFrom: { type: "latest" },
    snapshots: [],
    update: null,
    undoableUpdate: null,
    toOffer: { count: 2, commits: ["c1", "c2"] },
    behind: 1,
    sourceState: "open",
    shipped: null,
    unshipped: 0,
    reverted: null,
    revision: 1,
    ...overrides,
  }) satisfies BranchLineage;

const offerFrom = (branchThreadId: ThreadId, id: string): Offer => ({
  id: OfferId.make(id),
  sourceThreadId: sourceId,
  branchThreadId,
  senderId: hanad,
  senderKind: "person",
  note: null,
  state: "open",
  commits: [
    { sha: "c1", subject: "Add rationale", authorName: "Hanad" },
    { sha: "c2", subject: "Wire it", authorName: "Hanad" },
  ],
  files: [{ path: "src/rationale.ts", status: "added", additions: 10, deletions: 0 }],
  additions: 10,
  deletions: 0,
  base: "base",
  tip: "c2",
  replaced: false,
  armedAt: null,
  returnReason: null,
  returnPaths: [],
  decidedBy: null,
  decidedAt: null,
  revertedAt: null,
  revertedBy: null,
  waiting: null,
  createdAt,
  updatedAt: createdAt,
});

const createSource = (machine: SandboxId | null) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${sourceId}`),
      threadId: sourceId,
      projectId: ProjectId.make("project:pair"),
      title: "Prompt builder",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "kousik/prompt-builder",
      worktreePath: "/work/prompt-builder",
      ownerId: kousik,
      createdBy: "user",
      creationSource: "web",
    });
    if (machine === null) return;
    // The source's machine, as `sandbox.provision` would have named it.
    const thread = yield* projections.getThread(sourceId);
    yield* projections.apply({
      id: EventId.make("event:source-machine"),
      type: "thread.metadata-updated",
      threadId: sourceId,
      occurredAt: thread.createdAt,
      payload: { ...thread, sandboxId: machine },
    });
  });

const branchOff = (branchThreadId: ThreadId, machine: SandboxId | null) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "thread.branch-off",
      commandId: CommandId.make(`branch-off:${branchThreadId}`),
      actorId: hanad,
      createdBy: "user",
      creationSource: "web",
      sourceThreadId: sourceId,
      targetThreadId: branchThreadId,
      title: "Rationale per question",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: `hanad/${branchThreadId}`,
      worktreePath: `/work/${branchThreadId}`,
      sandboxId: machine,
      lineage: lineageOf(branchThreadId),
      sourceTurn: 6,
      uncommittedFiles: 2,
    });
  });

const lineageNotices = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return (yield* orchestrator.getThreadProjection(threadId)).turnItems.flatMap(
      (item: OrchestrationV2TurnItem) =>
        item.type === "system_notice" && item.lineage !== undefined
          ? [{ kind: item.lineage.kind, message: item.message }]
          : [],
    );
  });

const send = (text: string, type: "start_immediately" | "queue_after_active") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${text}`),
      threadId: sourceId,
      messageId: MessageId.make(`message:${text}`),
      text,
      attachments: [],
      dispatchMode: { type },
      createdBy: "user",
      creationSource: "web",
    });
  });

it.layer(layerTest)("branch off", (it) => {
  it.effect("gives the brancher a thread of their own on the source's machine", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const branchId = ThreadId.make("thread:rationale");
      yield* createSource(sandboxId);
      yield* branchOff(branchId, sandboxId);

      const branch = yield* projections.getThread(branchId);
      const source = yield* projections.getThread(sourceId);
      assert.deepStrictEqual(
        [branch.ownerId, branch.branch, branch.worktreePath, branch.sandboxId],
        [hanad, `hanad/${branchId}`, `/work/${branchId}`, sandboxId],
      );
      assert.deepStrictEqual(branch.lineage.relationshipToParent, null);
      // The source is never touched.
      assert.deepStrictEqual(
        [source.ownerId, source.worktreePath, source.branch],
        [kousik, "/work/prompt-builder", "kousik/prompt-builder"],
      );
      assert.deepStrictEqual(yield* projections.getBranchLineage(branchId), lineageOf(branchId));
      assert.deepStrictEqual(
        (yield* projections.listSandboxThreads(sandboxId)).map((row) => row.threadId),
        [sourceId, branchId],
      );
      assert.deepStrictEqual(
        [yield* projections.slotFor(sourceId), yield* projections.slotFor(branchId)],
        [0, 1],
      );
      assert.deepStrictEqual(yield* lineageNotices(branchId), [
        {
          kind: "branched-from",
          message:
            "Someone branched off Someone's Prompt builder at turn 6, with its 2 uncommitted files",
        },
      ]);
      assert.deepStrictEqual(yield* lineageNotices(sourceId), [
        {
          kind: "branched-off",
          message: "Someone branched off this thread → Rationale per question",
        },
      ]);

      // One level in v1, and only the source's own machine.
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            orchestrator.dispatch({
              type: "thread.branch-off",
              commandId: CommandId.make("branch-off:of-branch"),
              actorId: kousik,
              createdBy: "user",
              creationSource: "web",
              sourceThreadId: branchId,
              targetThreadId: ThreadId.make("thread:of-branch"),
              title: "Of a branch",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: "kousik/of-branch",
              worktreePath: "/work/of-branch",
              sandboxId: null,
              lineage: {
                ...lineageOf(ThreadId.make("thread:of-branch")),
                sourceThreadId: branchId,
              },
              sourceTurn: 0,
              uncommittedFiles: 0,
            }),
          ),
        ),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            branchOff(
              ThreadId.make("thread:elsewhere"),
              SandboxId.make("sbx_ffffffffffffffffffff"),
            ),
          ),
        ),
      );

      // Archiving a branch frees its slot, and the next branch takes it.
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive:rationale"),
        threadId: branchId,
      });
      const nextId = ThreadId.make("thread:second");
      yield* branchOff(nextId, sandboxId);
      assert.deepStrictEqual(
        [yield* projections.slotFor(branchId), yield* projections.slotFor(nextId)],
        [null, 1],
      );
    }),
  );
});

it.layer(layerTest)("an armed Apply against the queue", (it) => {
  it.effect("runs at the turn boundary before the queued message starts", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const recorded = yield* RecordingSteps.RecordedLineageSteps;
      const sql = yield* SqlClient.SqlClient;
      const branchId = ThreadId.make("thread:rationale");
      const offer = offerFrom(branchId, "ofr_00000000000000000001");
      yield* createSource(null);
      yield* branchOff(branchId, null);
      yield* orchestrator.dispatch({
        type: "offer.create",
        commandId: CommandId.make("offer:create"),
        threadId: sourceId,
        offer,
      });

      yield* send("first turn", "start_immediately");
      yield* send("queued message", "queue_after_active");
      // Apply during the turn arms it.
      yield* orchestrator.dispatch({
        type: "offer.arm",
        commandId: CommandId.make("offer:apply"),
        threadId: sourceId,
        offerId: offer.id,
        actorId: kousik,
      });
      const armed = yield* projections.getLineageStep(sourceId);
      assert.deepStrictEqual([armed?.kind, armed?.state], ["apply", "armed"]);
      assert.isNotNull((yield* projections.getOffer(offer.id))?.armedAt);

      // No provider runs here: only the lineage step's effect may be claimed.
      yield* sql`DELETE FROM orchestration_v2_effect_outbox`;
      const before = (yield* orchestrator.getThreadProjection(sourceId)).runs;
      const active = before.find((run) => run.status === "starting" || run.status === "running")!;
      const queued = before.find((run) => run.status === "queued")!;
      const afterSequence = yield* eventSink.latestSequence();
      const endedAt = yield* DateTime.now;
      yield* eventSink.writeWithEffects({
        events: [
          {
            id: EventId.make("event:first-turn-ended"),
            type: "run.updated",
            threadId: sourceId,
            runId: active.id,
            occurredAt: endedAt,
            payload: { ...active, status: "completed", completedAt: endedAt },
          },
        ],
        effects: [],
      });
      // The boundary starts the step, not the queued message.
      yield* eventSink.stream({ afterSequence, eventType: "thread.lineage-step.updated" }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "thread.lineage-step.updated" &&
            stored.event.payload.step?.state === "running",
        ),
        Stream.runHead,
      );
      assert.isFalse(yield* projections.canStartQueuedRun(sourceId));
      assert.strictEqual(
        (yield* orchestrator.getThreadProjection(sourceId)).runs.find((run) => run.id === queued.id)
          ?.status,
        "queued",
      );
      assert.deepStrictEqual(yield* Ref.get(recorded), []);

      yield* worker.drain(1);
      assert.deepStrictEqual(
        (yield* Ref.get(recorded)).map((step) => [step.kind, step.offerId]),
        [["apply", offer.id]],
      );
      assert.isNull(yield* projections.getLineageStep(sourceId));
      const firstSequence = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
        eventSink.stream({ afterSequence, threadId: sourceId }).pipe(
          Stream.filter((stored) => predicate(stored.event)),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
          Effect.map((stored) => stored.sequence),
        );
      const stepCleared = yield* firstSequence(
        (event) => event.type === "thread.lineage-step.updated" && event.payload.step === null,
      );
      const queuedStarted = yield* firstSequence(
        (event) =>
          event.type === "run.updated" &&
          event.runId === queued.id &&
          event.payload.status !== "queued",
      );
      assert.isTrue(queuedStarted > stepCleared);
    }),
  );
});

it.layer(layerTest)("the branch link on shells", (it) => {
  it.effect("is the same from both shell builders and hides a source the viewer can't open", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const branchId = ThreadId.make("thread:rationale");
      yield* createSource(null);
      yield* branchOff(branchId, null);
      yield* orchestrator.dispatch({
        type: "offer.create",
        commandId: CommandId.make("offer:create"),
        threadId: sourceId,
        offer: offerFrom(branchId, "ofr_00000000000000000001"),
      });

      const branchShell = yield* projections.getThreadShell(branchId);
      const sourceShell = yield* projections.getThreadShell(sourceId);
      assert.deepStrictEqual(branchShell?.branchLink?.source, {
        threadId: sourceId,
        ownerId: kousik,
        title: "Prompt builder",
        state: "open",
        toOffer: 2,
        behind: 1,
        updateInProgress: null,
        undoableUpdate: false,
        offerState: "open",
        allApplied: false,
        shippedLabel: null,
        unshipped: 0,
      });
      assert.deepStrictEqual(sourceShell?.branchLink?.openOffers, 1);
      assert.deepStrictEqual(sourceShell?.branchLink?.source, null);

      const snapshot = yield* projections.getShellSnapshot({ threadIds: [sourceId, branchId] });
      const links = yield* projections.getBranchLinks([sourceId, branchId]);
      for (const shell of [branchShell!, sourceShell!]) {
        const fromSnapshot = snapshot.threads.find((thread) => thread.id === shell.id);
        const fromMemory = ProjectionStore.threadShellFromProjection(
          yield* projections.getThreadProjection(shell.id),
          links.get(shell.id),
        );
        assert.deepStrictEqual(fromSnapshot?.branchLink, shell.branchLink);
        assert.deepStrictEqual(fromMemory.branchLink, shell.branchLink);
      }

      const access = {
        allows: () => true,
        allowsThreadId: (threadId: ThreadId) => threadId !== sourceId,
        caughtUp: Effect.void,
      } as unknown as ViewerAccess;
      const viewer: ThreadViewer = {
        memberId: hanad,
        serverOwnerId: kousik,
        isTeamMode: Effect.succeed(true),
        readMemberStates: () => Effect.succeed(new Map()),
        readFollowedThreadIds: Effect.succeed(new Set()),
        access,
      };
      const [viewed] = yield* overlayForViewer(viewer, [branchShell!]);
      assert.deepStrictEqual(
        [viewed?.branchLink?.source?.title, viewed?.branchLink?.source?.state],
        [null, "unavailable"],
      );
    }),
  );
});
