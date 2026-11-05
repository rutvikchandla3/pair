import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  CommandId,
  EventId,
  GuestMessageId,
  GuestShareId,
  MemberId,
  MessageId,
  NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { MemberRecord } from "../persistence/Members.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TeamState from "../team/TeamState.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import { decideHumanAuthorship } from "./HumanAuthorship.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
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
const alice = MemberId.make("member:alice");
const bob = MemberId.make("member:bob");
const memberRecord = (id: MemberId, isOwner: boolean): MemberRecord => ({
  id,
  name: id.slice("member:".length),
  role: isOwner ? "admin" : "member",
  gitName: null,
  gitEmail: null,
  isOwner,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: null,
  removedAt: null,
});

const makeLayer = (layerTeam: Layer.Layer<TeamState.TeamState> | Layer.Layer<never>) => {
  const layerDatabase = SqlitePersistence.layerMemory;
  return Layer.mergeAll(
    layerDatabase,
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "attribution" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: layerDatabase, runEffectWorker: false },
    ).pipe(Layer.provide(layerTeam)),
  );
};
const layerTest = makeLayer(Layer.empty);
const layerTeam = makeLayer(
  TeamState.layerTest([memberRecord(alice, true), memberRecord(bob, false)]),
);
const layerSolo = makeLayer(TeamState.layerTest([memberRecord(alice, true)]));

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
    { authorId: bob },
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

const carol = MemberId.make("member:carol");
const pullRequestKey = { host: "github.com", repository: "owner/repository", number: 7 };
const linkPullRequest = (source: "manual" | "created" | "agent" | "stack") => ({
  type: "thread.pull-request.link" as const,
  ...pullRequestKey,
  url: "https://github.com/owner/repository/pull/7",
  source,
});
const unlinkPullRequest = { type: "thread.pull-request.unlink" as const, ...pullRequestKey };
const lifecycleNotices = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadProjection(threadId),
  ).pipe(
    Effect.map((projection) =>
      projection.turnItems.flatMap((item) =>
        item.type === "system_notice" ? [[item.message, item.actorId, item.runId]] : [],
      ),
    ),
  );

it.effect.each([
  {
    row: "permissions",
    command: { type: "thread.runtime-mode.set", runtimeMode: "auto" },
    notice: "bob set permissions to Auto",
  },
  {
    row: "unchanged permissions",
    command: { type: "thread.runtime-mode.set", runtimeMode: "full-access" },
    notice: null,
  },
  {
    row: "interaction mode",
    command: { type: "thread.interaction-mode.set", interactionMode: "plan" },
    notice: null,
  },
  {
    row: "take over",
    command: { type: "thread.owner.set", ownerId: bob },
    notice: "bob took over this thread",
  },
  {
    row: "assign",
    command: { type: "thread.owner.set", ownerId: bob },
    actorId: alice,
    notice: "alice assigned this thread to bob",
  },
  {
    row: "assign to a removed member",
    command: { type: "thread.owner.set", ownerId: carol },
    notice: "bob assigned this thread to a former member",
  },
  { row: "unchanged owner", command: { type: "thread.owner.set", ownerId: alice }, notice: null },
  { row: "archive", command: { type: "thread.archive" }, notice: "bob archived this thread" },
  {
    row: "archive by a removed member",
    command: { type: "thread.archive" },
    actorId: carol,
    notice: "A former member archived this thread",
  },
  {
    row: "archive with no actor",
    command: { type: "thread.archive" },
    actorId: null,
    notice: null,
  },
  {
    row: "archive on a solo server",
    command: { type: "thread.archive" },
    actorId: alice,
    solo: true,
    notice: null,
  },
  {
    row: "unarchive",
    setup: [{ type: "thread.archive" }],
    command: { type: "thread.unarchive" },
    notice: "bob unarchived this thread",
  },
  { row: "settle", command: { type: "thread.settle" }, notice: "bob settled this thread" },
  {
    row: "unsettle",
    setup: [{ type: "thread.settle" }],
    command: { type: "thread.unsettle" },
    notice: "bob un-settled this thread",
  },
  { row: "unsettle an active thread", command: { type: "thread.unsettle" }, notice: null },
  {
    row: "rename",
    command: { type: "thread.metadata.update", title: "Ship it" },
    notice: "bob renamed this thread to “Ship it”",
  },
  {
    row: "same title",
    command: { type: "thread.metadata.update", title: "thread:notice:same title" },
    notice: null,
  },
  { row: "manual link", command: linkPullRequest("manual"), notice: "bob linked PR #7" },
  { row: "created link", command: linkPullRequest("created"), notice: "bob opened PR #7" },
  { row: "agent link", command: linkPullRequest("agent"), notice: "bob linked PR #7" },
  { row: "stack link", command: linkPullRequest("stack"), notice: null },
  {
    row: "link again",
    setup: [linkPullRequest("manual")],
    command: linkPullRequest("manual"),
    notice: null,
  },
  {
    row: "unlink",
    setup: [linkPullRequest("manual")],
    command: unlinkPullRequest,
    notice: "bob unlinked PR #7",
  },
  {
    row: "unlink a stack layer",
    setup: [linkPullRequest("stack")],
    command: unlinkPullRequest,
    notice: null,
  },
] as const)("lifecycle notice: $row", (testCase) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`thread:notice:${testCase.row}`);
    yield* createThread(threadId, { actorId: alice });
    const dispatch = (id: string, command: object, actorId?: MemberId) =>
      orchestrator.dispatch({
        ...command,
        commandId: CommandId.make(`${threadId}:${id}`),
        threadId,
        ...(actorId === undefined ? {} : { actorId }),
      } as OrchestrationV2ServerCommand);
    for (const [index, step] of ("setup" in testCase ? testCase.setup : []).entries()) {
      yield* dispatch(`setup:${index}`, step);
    }
    const actorId = "actorId" in testCase ? testCase.actorId : bob;
    yield* dispatch("command", testCase.command, actorId ?? undefined);
    assert.deepEqual(
      yield* lifecycleNotices(threadId),
      testCase.notice === null ? [] : [[testCase.notice, actorId, null]],
    );
  }).pipe(Effect.provide("solo" in testCase ? layerSolo : layerTeam)),
);

it.effect(
  "a lifecycle notice keeps its place in the timeline when the run before it rolls back",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:notice-rollback");
      yield* createThread(threadId, { actorId: alice });
      yield* send(threadId, "notice-rollback-first", {
        actorId: alice,
        dispatchMode: { type: "start_immediately" },
      });
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("notice-rollback-mode"),
        threadId,
        runtimeMode: "auto",
        actorId: bob,
      });
      const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      const now = yield* DateTime.now;
      yield* (yield* ProjectionStore.ProjectionStoreV2).apply({
        id: EventId.make("event:notice-rollback"),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "rolled_back", completedAt: now },
      });
      yield* send(threadId, "notice-rollback-second", { actorId: alice });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        projection.visibleTurnItems.map(({ item }) =>
          item.type === "user_message" ? item.messageId : item.type,
        ),
        ["system_notice", "notice-rollback-second"],
      );
    }).pipe(Effect.provide(layerTeam)),
);

/** Moves the thread's first run to a running provider turn that accepts steers. */
const seedRunningTurn = Effect.fnUntraced(function* (threadId: ThreadId) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const initial = yield* orchestrator.getThreadProjection(threadId);
  const run = initial.runs[0]!;
  const providerThread = initial.providerThreads[0]!;
  const now = yield* DateTime.now;
  const providerSession = {
    id: providerThread.providerSessionId!,
    driver: adapter.driver,
    providerInstanceId: instanceId,
    status: "running" as const,
    cwd: process.cwd(),
    model: modelSelection.model,
    capabilities: CodexProviderCapabilitiesV2,
    createdAt: now,
    updatedAt: now,
    lastError: null,
  };
  yield* (yield* EventSink.EventSinkV2).write({
    commandId: CommandId.make(`running:${threadId}`),
    events: [
      {
        id: EventId.make(`running-run:${threadId}`),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "running", startedAt: now },
      },
      {
        id: EventId.make(`running-session:${threadId}`),
        type: "provider-session.attached",
        threadId,
        occurredAt: now,
        payload: providerSession,
      },
      {
        id: EventId.make(`running-turn:${threadId}`),
        type: "provider-turn.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: {
          id: ProviderTurnId.make(`turn:${threadId}`),
          providerThreadId: providerThread.id,
          nodeId: run.rootNodeId!,
          runAttemptId: run.activeAttemptId,
          nativeTurnRef: null,
          ordinal: 1,
          status: "running",
          startedAt: now,
          completedAt: null,
        },
      },
    ],
  });
  const sessionSpy = vi
    .spyOn(sessions, "get")
    .mockReturnValue(
      Effect.succeedSome({ providerSession } as ProviderAdapter.ProviderAdapterV2SessionRuntime),
    );
  yield* Effect.addFinalizer(() => Effect.sync(() => sessionSpy.mockRestore()));
  return run.id;
});

it.effect.each([
  { row: "Bob's plain send on Alice's turn queues", intent: "auto", outcome: "queued" },
  { row: "Bob's steer on Alice's turn queues", intent: "steer", outcome: "queued" },
  { row: "Bob's restart on Alice's turn queues", intent: "restart", outcome: "queued" },
  { row: "Bob's Steer now steers", intent: "steer", steerOthersTurn: true, outcome: "joined" },
  { row: "Alice steers her own turn", intent: "auto", actorId: alice, outcome: "joined" },
  { row: "an agent run is the holder's turn", intent: "auto", agentRun: true, outcome: "queued" },
  { row: "a send with no actor steers", intent: "auto", actorId: null, outcome: "joined" },
  { row: "a solo server steers as before", intent: "auto", solo: true, outcome: "joined" },
  { row: "Bob's /goal leaves Alice's turn running", intent: "auto", goal: true, outcome: "queued" },
] as const)("queue-not-steer: $row", (testCase) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`thread:queue-not-steer:${testCase.row}`);
    yield* createThread(threadId, { actorId: alice });
    yield* send(threadId, `${threadId}:start`, {
      dispatchMode: { type: "start_immediately" },
      ...("agentRun" in testCase
        ? { createdBy: "agent", creationSource: "mcp", actorId: bob }
        : { actorId: alice }),
    });
    const runId = yield* seedRunningTurn(threadId);
    const actorId = "actorId" in testCase ? testCase.actorId : bob;
    const messageId = `${threadId}:send`;
    yield* send(threadId, messageId, {
      text: "goal" in testCase ? "/goal ship it" : messageId,
      dispatchMode: { type: "start_immediately" },
      deliveryIntent: testCase.intent,
      ...(actorId === null ? {} : { actorId }),
      ...("steerOthersTurn" in testCase ? { steerOthersTurn: true } : {}),
    });
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const message = projection.messages.find((candidate) => candidate.id === messageId);
    const queued = projection.runs.find((run) => run.id === message?.runId)?.status === "queued";
    const stopped = projection.turnItems.some((item) => item.type === "run_interrupt_request");
    assert.deepEqual(
      [message?.runId === runId ? "joined" : queued ? "queued" : "other", stopped],
      [testCase.outcome, false],
    );
  }).pipe(Effect.provide("solo" in testCase ? layerSolo : layerTeam)),
);

type QueueAction = "cancel" | "edit" | "promote" | "reorder" | "start";
const queueCommand = (
  action: QueueAction,
  threadId: ThreadId,
  runId: RunId,
  otherRunId: RunId,
  activeRunId: RunId | undefined,
  actorId: MemberId | null,
): OrchestrationV2Command => {
  const common = {
    commandId: CommandId.make(`${action}:${threadId}`),
    threadId,
    ...(actorId === null ? {} : { actorId }),
  };
  switch (action) {
    case "cancel":
      return { ...common, type: "queued-run.cancel", runId };
    case "edit":
      return { ...common, type: "queued-run.edit", runId, text: "Edited" };
    case "promote":
      return {
        ...common,
        type: "queued-message.promote-to-steer",
        queuedRunId: runId,
        targetRunId: activeRunId ?? runId,
      };
    case "reorder":
      return { ...common, type: "queued-run.reorder", runId, beforeRunId: otherRunId };
    case "start":
      return { ...common, type: "queued-run.start", runId };
  }
};

it.effect.each([
  { row: "Bob cancels Alice's queued run", action: "cancel", actor: bob, target: alice },
  { row: "Bob edits Alice's queued text", action: "edit", actor: bob, target: alice },
  { row: "Bob sends Alice's queued run now", action: "promote", actor: bob, target: alice },
  { row: "Bob reorders Alice's queued run", action: "reorder", actor: bob, target: alice },
  { row: "Bob starts Alice's queued run", action: "start", actor: bob, target: alice, idle: true },
  { row: "owner Alice edits Bob's queued text", action: "edit", actor: alice, target: bob },
  { row: "owner Alice cancels Bob's", action: "cancel", actor: alice, target: bob, allowed: true },
  { row: "owner Alice sends Bob's now", action: "promote", actor: alice, target: bob, allowed: true },
  { row: "owner Alice reorders Bob's", action: "reorder", actor: alice, target: bob, allowed: true },
  { row: "Bob edits his own", action: "edit", actor: bob, target: bob, allowed: true },
  { row: "Bob cancels his own", action: "cancel", actor: bob, target: bob, allowed: true },
  { row: "Bob sends his own now", action: "promote", actor: bob, target: bob, allowed: true },
  { row: "Bob starts his own", action: "start", actor: bob, target: bob, idle: true, allowed: true },
  { row: "no actor edits Alice's", action: "edit", actor: null, target: alice, allowed: true },
  { row: "a solo server", action: "edit", actor: bob, target: alice, solo: true, allowed: true },
] as const)("queue control: $row", (testCase) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`thread:queue-control:${testCase.row}`);
    yield* createThread(threadId, { actorId: alice });
    yield* send(threadId, `${threadId}:first`, {
      dispatchMode: { type: "start_immediately" },
      actorId: alice,
    });
    const activeRunId = yield* seedRunningTurn(threadId);
    for (const author of [alice, bob]) {
      yield* send(threadId, `${threadId}:${author}`, { actorId: author });
    }
    const projection = yield* orchestrator.getThreadProjection(threadId);
    if ("idle" in testCase) {
      // A stopped turn with its queue held, so a queued run can only start on demand.
      const occurredAt = yield* DateTime.now;
      yield* (yield* EventSink.EventSinkV2).write({
        commandId: CommandId.make(`stopped:${threadId}`),
        events: projection.runs.map((run) => ({
          id: EventId.make(`stopped:${run.id}`),
          type: "run.updated" as const,
          threadId,
          runId: run.id,
          occurredAt,
          payload:
            run.id === activeRunId
              ? { ...run, status: "interrupted" as const }
              : { ...run, queueHeld: true },
        })),
      });
    }
    const [runId, otherRunId] = [testCase.target, testCase.target === alice ? bob : alice].map(
      (author) =>
        projection.messages.find((message) => message.id === `${threadId}:${author}`)!.runId!,
    );
    const command = queueCommand(
      testCase.action,
      threadId,
      runId!,
      otherRunId!,
      "idle" in testCase ? undefined : activeRunId,
      testCase.actor,
    );
    const outcome = yield* orchestrator.dispatch(command).pipe(
        Effect.as("allowed"),
        Effect.catchTags({
          OrchestratorDispatchError: (error) => Effect.succeed(String(error.cause)),
          OrchestratorCommandRejectedError: (error) => Effect.succeed(String(error.cause)),
        }),
      );
    const starter = testCase.target.slice("member:".length);
    assert.equal(
      outcome,
      "allowed" in testCase
        ? "allowed"
        : testCase.action === "edit"
          ? `Only ${starter} can edit this queued message.`
          : `Only ${starter} or the thread owner can change this queued message.`,
    );
  }).pipe(Effect.provide("solo" in testCase ? layerSolo : layerTeam)),
);

it.effect.each([
  { row: "on a team, Bob sends it and can cancel it", sender: "bob", authorId: bob },
  { row: "solo, the owner sends it", solo: true, sender: "the owner", authorId: undefined },
] as const)("guest send: $row", (testCase) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`thread:guest-send:${testCase.row}`);
    const shareId = GuestShareId.make(`share:${threadId}`);
    const guestMessageId = GuestMessageId.make(`guest:${threadId}`);
    const actorId = "solo" in testCase ? alice : bob;
    yield* createThread(threadId, { actorId: alice });
    yield* send(threadId, `${threadId}:first`, { dispatchMode: { type: "defer_start" } });
    const share = { commandId: CommandId.make(`share:${threadId}`), threadId, shareId };
    yield* orchestrator.dispatch({
      ...share,
      type: "thread.guest-share.open",
      host: "env.t3.test",
      expiresAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 1 })),
    });
    yield* orchestrator.dispatch({
      ...share,
      commandId: CommandId.make(`redeem:${threadId}`),
      type: "thread.guest-share.redeem",
      guestName: "Sam",
    });
    yield* orchestrator.dispatch({
      ...share,
      commandId: CommandId.make(`submit:${threadId}`),
      type: "thread.guest-message.submit",
      guestMessageId,
      text: "Why?",
    });
    yield* send(threadId, `${threadId}:guest`, { guestMessageId, actorId });
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const message = projection.messages.find((candidate) => candidate.id === `${threadId}:guest`);
    assert.deepEqual(
      [message?.text, message?.authorId],
      [`Message from guest Sam, sent by ${testCase.sender}:\n\nWhy?`, testCase.authorId],
    );
    yield* orchestrator.dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make(`cancel:${threadId}`),
      threadId,
      runId: message!.runId!,
      actorId,
    });
  }).pipe(Effect.provide("solo" in testCase ? layerSolo : layerTeam)),
);
