import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MemberId,
  MessageId,
  NodeId,
  type OrchestrationV2Command,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import { decideHumanAuthorship } from "./HumanAuthorship.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

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
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "attribution" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const alice = MemberId.make("member:alice");
const bob = MemberId.make("member:bob");

type MessageDispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

const createThread = (threadId: ThreadId, fields: { actorId?: MemberId; ownerId?: MemberId }) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:attribution"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      ...fields,
    }),
  );

const send = (threadId: ThreadId, id: string, fields: Partial<MessageDispatch> = {}) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${id}`),
      threadId,
      messageId: MessageId.make(id),
      text: id,
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
      ...fields,
    }),
  );

it.each([
  ["agent", { createdBy: "agent" as const, actorId: bob }, {}],
  ["no actor", { createdBy: "user" as const }, {}],
  [
    "scheduled",
    { createdBy: "user" as const, actorId: bob, scheduledTaskId: ScheduledTaskId.make("t") },
    {},
  ],
  [
    "thread sender",
    { createdBy: "user" as const, actorId: bob, senderThreadId: ThreadId.make("s") },
    {},
  ],
  [
    "notification",
    {
      createdBy: "user" as const,
      actorId: bob,
      notification: {
        source: { kind: "delegated_task" as const, taskIds: [NodeId.make("n")] },
        outcome: "updated" as const,
        summary: "s",
      },
    },
    {},
  ],
  [
    "guest",
    {
      createdBy: "user" as const,
      actorId: bob,
      context: { version: 1 as const, records: [], guest: { name: "Sam", text: "Hi" } },
    },
    {},
  ],
  [
    "first author",
    { createdBy: "user" as const, actorId: alice },
    { authorId: alice, humanAuthorIds: [alice] },
  ],
])("decideHumanAuthorship: %s on an empty thread", (_name, command, expected) => {
  assert.deepEqual(
    decideHumanAuthorship({}, command as Parameters<typeof decideHumanAuthorship>[1]),
    expected,
  );
});

it.effect("stamps authors at dispatch and labels senders only once a second member writes", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:authorship");
    yield* createThread(threadId, { actorId: alice });
    const steps = [
      { id: "alice-start", actorId: alice, start: true, authors: [alice] },
      { id: "alice-queued", actorId: alice, authors: [alice] },
      { id: "agent-queued", agent: true, authors: [alice] },
      { id: "bob-joins", actorId: bob, label: "name_with_note", authors: [alice, bob] },
      { id: "alice-again", actorId: alice, label: "name", authors: [alice, bob] },
    ] as const;
    for (const step of steps) {
      yield* send(threadId, step.id, {
        ...("actorId" in step ? { actorId: step.actorId } : {}),
        ...("agent" in step ? { createdBy: "agent", creationSource: "mcp" } : {}),
        ...("start" in step ? { dispatchMode: { type: "start_immediately" } } : {}),
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const message = projection.messages.find((candidate) => candidate.id === step.id);
      assert.deepEqual(
        [message?.authorId, message?.senderLabel, projection.thread.humanAuthorIds],
        [
          "actorId" in step ? step.actorId : undefined,
          "label" in step ? step.label : undefined,
          step.authors,
        ],
        step.id,
      );
    }
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const startItem = projection.turnItems.find(
      (item) => item.type === "user_message" && item.messageId === "alice-start",
    );
    assert.equal(startItem?.type === "user_message" ? startItem.authorId : null, alice);
    assert.isUndefined(startItem?.type === "user_message" ? startItem.senderLabel : null);
    assert.deepEqual(
      projection.runs.map((run) => run.status),
      ["starting", "queued", "queued", "queued", "queued"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["thread.stop", "run.interrupt"] as const)(
  "%s records who stopped the run",
  (type) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make(`thread:stop-actor:${type}`);
      yield* createThread(threadId, {});
      yield* send(threadId, `start:${type}`, { dispatchMode: { type: "start_immediately" } });
      const runId = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!.id;
      yield* orchestrator.dispatch(
        type === "thread.stop"
          ? { type, commandId: CommandId.make(`stop:${type}`), threadId, actorId: bob }
          : { type, commandId: CommandId.make(`stop:${type}`), threadId, runId, actorId: bob },
      );
      const item = (yield* orchestrator.getThreadProjection(threadId)).turnItems.find(
        (candidate) => candidate.type === "run_interrupt_request",
      );
      assert.equal(item?.type === "run_interrupt_request" ? item.actorId : null, bob);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("respond records the responder on the request, its item and the async answer", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:respond-actor");
    const requestId = RuntimeRequestId.make("request:respond-actor");
    const nodeId = NodeId.make("node:respond-actor");
    const now = yield* DateTime.now;
    yield* createThread(threadId, { actorId: alice });
    yield* projections.apply({
      id: EventId.make("event:respond-actor-request"),
      type: "runtime-request.updated",
      threadId,
      nodeId,
      occurredAt: now,
      payload: {
        id: requestId,
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      },
    });
    yield* projections.apply({
      id: EventId.make("event:respond-actor-item"),
      type: "turn-item.updated",
      threadId,
      nodeId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("turn-item:respond-actor"),
        type: "user_input_request",
        threadId,
        runId: null,
        nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "waiting",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        requestId,
        questions: [{ id: "color", header: "Color", question: "Which color?", options: [] }],
      },
    });
    yield* orchestrator.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make("respond:actor"),
      threadId,
      requestId,
      answers: { color: "Blue" },
      actorId: bob,
    });
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(projection.runtimeRequests.find((row) => row.id === requestId)?.resolvedBy, bob);
    const item = projection.turnItems.find((candidate) => candidate.type === "user_input_request");
    assert.equal(item?.type === "user_input_request" ? item.resolvedBy : null, bob);
    const answer = projection.messages.find(
      (message) => message.id === MessageId.make(`async-answer:${requestId}`),
    );
    assert.equal(answer?.authorId, bob);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("owner rules for create, fork, side chat, delegated child and owner.set", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const owner = (threadId: ThreadId) =>
      orchestrator.getThreadProjection(threadId).pipe(Effect.map((p) => p.thread.ownerId));
    const parentId = ThreadId.make("thread:owner-parent");
    yield* createThread(parentId, { actorId: alice });
    yield* createThread(ThreadId.make("thread:owner-on-behalf"), { actorId: bob, ownerId: alice });
    yield* createThread(ThreadId.make("thread:owner-none"), {});
    assert.deepEqual(
      [
        yield* owner(parentId),
        yield* owner(ThreadId.make("thread:owner-on-behalf")),
        yield* owner(ThreadId.make("thread:owner-none")),
      ],
      [alice, alice, null],
    );

    yield* send(parentId, "owner-parent-start", {
      actorId: alice,
      dispatchMode: { type: "start_immediately" },
    });
    const parentRun = (yield* orchestrator.getThreadProjection(parentId)).runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("owner-delegate"),
      parentThreadId: parentId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "child task",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const childId = (yield* orchestrator.getThreadProjection(parentId)).subagents[0]!
      .childThreadId!;
    const child = (yield* orchestrator.getThreadProjection(childId)).thread;
    assert.deepEqual([child.ownerId, child.humanAuthorIds], [alice, undefined]);

    const sourceId = ThreadId.make("thread:owner-fork-source");
    yield* createThread(sourceId, { actorId: bob });
    yield* send(sourceId, "owner-fork-start", { dispatchMode: { type: "start_immediately" } });
    const sourceRun = (yield* orchestrator.getThreadProjection(sourceId)).runs[0]!;
    const now = yield* DateTime.now;
    yield* (yield* ProjectionStore.ProjectionStoreV2).apply({
      id: EventId.make("event:owner-fork-source-completed"),
      type: "run.updated",
      threadId: sourceId,
      runId: sourceRun.id,
      occurredAt: now,
      payload: { ...sourceRun, status: "completed", completedAt: now },
    });
    const fork = (targetId: string, fields: { actorId?: MemberId; sideChat?: boolean }) =>
      orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make(`fork:${targetId}`),
        sourceThreadId: sourceId,
        targetThreadId: ThreadId.make(targetId),
        sourcePoint: { type: "run", runId: sourceRun.id },
        createdBy: "user",
        creationSource: "web",
        ...fields,
      });
    yield* fork("thread:owner-fork-by-alice", { actorId: alice });
    yield* fork("thread:owner-fork-no-actor", {});
    yield* fork("thread:owner-side-chat", { actorId: alice, sideChat: true });
    assert.deepEqual(
      [
        yield* owner(ThreadId.make("thread:owner-fork-by-alice")),
        yield* owner(ThreadId.make("thread:owner-fork-no-actor")),
        yield* owner(ThreadId.make("thread:owner-side-chat")),
      ],
      [alice, bob, bob],
    );

    yield* orchestrator.dispatch({
      type: "thread.owner.set",
      commandId: CommandId.make("owner-set"),
      threadId: parentId,
      ownerId: bob,
      actorId: alice,
    });
    const reassigned = (yield* orchestrator.getThreadProjection(parentId)).thread;
    assert.deepEqual([reassigned.ownerId, reassigned.ownerUpdatedBy], [bob, alice]);
    const sequence = yield* orchestrator.getThreadEventSequence(parentId);
    const same = yield* orchestrator.dispatch({
      type: "thread.owner.set",
      commandId: CommandId.make("owner-set-same"),
      threadId: parentId,
      ownerId: bob,
      actorId: bob,
    });
    assert.deepEqual(same.storedEvents, []);
    assert.equal(yield* orchestrator.getThreadEventSequence(parentId), sequence);
    // Receipts are keyed by commandId alone, so another actor replays the original outcome.
    const replayed = yield* orchestrator.dispatch({
      type: "thread.owner.set",
      commandId: CommandId.make("owner-set"),
      threadId: parentId,
      ownerId: alice,
      actorId: bob,
    });
    assert.isTrue(replayed.replayed);
    assert.equal(yield* owner(parentId), bob);
  }).pipe(Effect.provide(layerTest)),
);
