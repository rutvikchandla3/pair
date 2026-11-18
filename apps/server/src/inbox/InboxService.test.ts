import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type InboxItem,
  MemberId,
  MessageId,
  NodeId,
  type Offer,
  OfferId,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  SpaceId,
  SpaceTaskId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TeamState from "../team/TeamState.ts";
import * as ThreadAccess from "../team/ThreadAccess.ts";
import * as BotService from "../bots/BotService.ts";
import * as BotStore from "../bots/BotStore.ts";
import { BotEscalations, BotThreads } from "../bots/botThreads.ts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as InboxService from "./InboxService.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("The Inbox never reaches a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const rutvik = MemberId.make("member:rutvik");
const kousik = MemberId.make("member:kousik");
const hanad = MemberId.make("member:hanad");
const record = (id: MemberId, isOwner: boolean) => ({
  id,
  name: id,
  role: isOwner ? ("admin" as const) : ("member" as const),
  gitName: null,
  gitEmail: null,
  isOwner,
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: null,
  removedAt: null,
});

const layerDatabase = SqlitePersistence.layerMemory;
const layerTeam = TeamState.layerTest([
  record(rutvik, true),
  record(kousik, false),
  record(hanad, false),
]);
const layerOrchestration = Layer.mergeAll(
  layerDatabase,
  layerTeam,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "inbox" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ).pipe(Layer.provide(layerTeam)),
);

// The bot store shares the one in-memory database, so a bot write and a projection read see each
// other; the thread-management stub is enough, since the Inbox never stops a thread.
const threadStub = {
  dispatch: () => Effect.succeed({ sequence: 0, storedEvents: [] }),
} as unknown as ThreadManagementService.ThreadManagementService["Service"];
const layerBotService = BotService.layer({ cloudOnly: false }).pipe(
  Layer.provide(BotStore.layer.pipe(Layer.provide(layerDatabase))),
  Layer.provide(Layer.succeed(ThreadManagementService.ThreadManagementService, threadStub)),
  Layer.provide(SecureRandom.layerWebCrypto),
);
const layer = Layer.provideMerge(
  InboxService.layer,
  Layer.merge(layerOrchestration, layerBotService),
);

const spaceId = SpaceId.make("spc_0123456789abcdef0123");
const roomThreadId = ThreadId.make("thread:room");
const projectId = ProjectId.make("project:inbox");
const base = { spaceId, threadId: roomThreadId } as const;
const task = SpaceTaskId.make("stk_00000000000000000001");

let counter = 0;
const commandId = (label: string) => CommandId.make(`${label}:${++counter}`);

const dispatch = (command: OrchestrationV2ServerCommand) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) => orchestrator.dispatch(command));

const createSpace = dispatch({
  type: "space.create",
  ...base,
  commandId: commandId("create"),
  actorId: rutvik,
  createdBy: "user",
  creationSource: "web",
  name: "Question creation",
  brief: "Ship the new question editor.",
  repositoryIds: [projectId],
  projectId,
  memberIds: [kousik, hanad],
  modelSelection,
});

const createTask = (actorId: MemberId, ownerId: MemberId, taskId: SpaceTaskId = task) =>
  dispatch({
    type: "space.task.create",
    ...base,
    commandId: commandId("task"),
    actorId,
    taskId,
    title: "Seed role catalog",
    description: "Seed the role catalog",
    ownerId,
    status: "todo",
  });

const visitRoom = (actorId: MemberId) =>
  Effect.flatMap(DateTime.now, (now) =>
    dispatch({
      type: "thread.visit",
      commandId: commandId("visit"),
      threadId: roomThreadId,
      visitedAt: DateTime.formatIso(now),
      actorId,
    }),
  );

const inbox = (memberId: MemberId, mayOpen?: (threadId: ThreadId) => boolean) =>
  Effect.flatMap(InboxService.InboxService, (service) =>
    service.list({ memberId, ...(mayOpen === undefined ? {} : { mayOpen }) }, {}),
  );
const reasons = (items: ReadonlyArray<InboxItem>) => items.map((item) => item.reason);

/** A thread `ownerId` holds, last prompted by `prompterId`, waiting on an approval. */
const pendingApproval = (ownerId: MemberId, prompterId: MemberId) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:approval");
    yield* dispatch({
      type: "thread.create",
      commandId: commandId("thread"),
      actorId: ownerId,
      threadId,
      projectId,
      title: "Migrate",
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      ownerId,
    });
    yield* dispatch({
      type: "message.dispatch",
      commandId: commandId("send"),
      threadId,
      messageId: MessageId.make("message:migrate"),
      text: "Run the migration",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
      actorId: prompterId,
    });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const requestId = RuntimeRequestId.make("request:migrate");
    const nodeId = NodeId.make("node:migrate");
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("event:approval-request"),
      type: "runtime-request.updated",
      threadId,
      nodeId,
      occurredAt: now,
      payload: {
        id: requestId,
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      },
    });
    yield* projections.apply({
      id: EventId.make("event:approval-item"),
      type: "turn-item.updated",
      threadId,
      nodeId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("turn-item:approval"),
        type: "approval_request",
        threadId,
        runId: null,
        nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "waiting",
        title: "Run command",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        requestId,
        requestKind: "command",
        prompt: "pnpm db:migrate",
      },
    });
    return threadId;
  });

it.effect("asks an approval of the thread's holder and its prompter, never a third member", () =>
  Effect.gen(function* () {
    const threadId = yield* pendingApproval(kousik, hanad);
    for (const memberId of [kousik, hanad]) {
      const approvals = (yield* inbox(memberId)).items.filter((i) => i.reason === "approval");
      assert.deepStrictEqual(
        approvals.map((item) => [item.threadId, item.threadOwnerId, item.excerpt, item.group]),
        [[threadId, kousik, "pnpm db:migrate", "needs-you"]],
      );
    }
    assert.notInclude(reasons((yield* inbox(rutvik)).items), "approval");
    // Without access the thread is not there, so neither is its approval.
    const blind = yield* inbox(kousik, (id) => id !== threadId);
    assert.notInclude(reasons(blind.items), "approval");
    assert.equal(blind.summary.needsYou, 0);
  }).pipe(Effect.provide(layer)),
);

const sourceThreadId = ThreadId.make("thread:source");
const offer = (id: string, state: Offer["state"]): Offer => ({
  id: OfferId.make(`ofr_${id.padStart(20, "0")}`),
  sourceThreadId,
  branchThreadId: ThreadId.make("thread:branch"),
  senderId: hanad,
  senderKind: "person",
  note: null,
  state,
  commits: [
    { sha: "a".repeat(40), subject: "Seed roles", authorName: "Hanad" },
    { sha: "b".repeat(40), subject: "Fix roles", authorName: "Hanad" },
  ],
  files: [],
  additions: 2,
  deletions: 0,
  base: "c".repeat(40),
  tip: "b".repeat(40),
  replaced: false,
  armedAt: null,
  returnReason: null,
  returnPaths: [],
  decidedBy: null,
  decidedAt: null,
  revertedAt: null,
  revertedBy: null,
  waiting: null,
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
});
const updateOffer = (payload: Offer) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* projections.apply({
      id: EventId.make(`event:${payload.id}:${payload.state}`),
      type: "thread.offer.updated",
      threadId: payload.sourceThreadId,
      occurredAt: yield* DateTime.now,
      payload,
    });
  });

it.effect("asks the source's holder to decide an open offer, until it's decided", () =>
  Effect.gen(function* () {
    yield* dispatch({
      type: "thread.create",
      commandId: commandId("thread"),
      actorId: kousik,
      threadId: sourceThreadId,
      projectId,
      title: "Roles",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      ownerId: kousik,
    });
    const open = offer("1", "open");
    yield* updateOffer(open);
    yield* updateOffer(offer("2", "withdrawn"));
    const offers = (yield* inbox(kousik)).items.filter((i) => i.reason === "offer");
    assert.deepStrictEqual(
      offers.map((item) => [
        item.id,
        item.group,
        item.actorId,
        item.threadId,
        item.threadTitle,
        item.threadOwnerId,
        item.offerId,
        item.excerpt,
      ]),
      [
        [
          `offer:${open.id}`,
          "needs-you",
          hanad,
          sourceThreadId,
          "Roles",
          kousik,
          open.id,
          "2 commits",
        ],
      ],
    );
    // Only the source's holder decides; the sender and everyone else wait.
    assert.notInclude(reasons((yield* inbox(hanad)).items), "offer");
    assert.notInclude(reasons((yield* inbox(rutvik)).items), "offer");
    const blind = yield* inbox(kousik, (id) => id !== sourceThreadId);
    assert.notInclude(reasons(blind.items), "offer");

    yield* updateOffer({ ...open, state: "declined", decidedBy: kousik });
    assert.notInclude(reasons((yield* inbox(kousik)).items), "offer");
  }).pipe(Effect.provide(layer)),
);

it.effect("asks the owner to start a task someone else gave them, until it starts", () =>
  Effect.gen(function* () {
    yield* createSpace;
    yield* createTask(rutvik, kousik);
    const assigned = (yield* inbox(kousik)).items.filter((i) => i.reason === "task-assigned");
    assert.deepStrictEqual(
      assigned.map((item) => [item.taskId, item.actorId, item.spaceId, item.taskTitle]),
      [[task, rutvik, spaceId, "Seed role catalog"]],
    );
    // Their own task never waits on them.
    assert.notInclude(reasons((yield* inbox(rutvik)).items), "task-assigned");
    const summary = (yield* inbox(kousik)).summary;
    assert.deepStrictEqual([summary.needsYou, summary.bySpace], [1, [{ spaceId, needsYou: 1 }]]);

    yield* dispatch({
      type: "space.task.update",
      ...base,
      commandId: commandId("start"),
      actorId: kousik,
      taskId: task,
      change: {
        type: "status",
        status: "in-progress",
        by: { type: "member", memberId: kousik },
        askedBy: null,
      },
    });
    assert.notInclude(reasons((yield* inbox(kousik)).items), "task-assigned");
  }).pipe(Effect.provide(layer)),
);

it.effect("hands a task back to its new owner, with the reason", () =>
  Effect.gen(function* () {
    yield* createSpace;
    yield* createTask(rutvik, kousik);
    yield* dispatch({
      type: "space.task.update",
      ...base,
      commandId: commandId("hand-back"),
      actorId: kousik,
      taskId: task,
      change: { type: "hand-back", reason: "On leave this week" },
    });
    const items = (yield* inbox(rutvik)).items.filter((i) => i.reason === "task-handed-back");
    assert.deepStrictEqual(
      items.map((item) => [item.actorId, item.excerpt]),
      [[kousik, "On leave this week"]],
    );
    assert.deepStrictEqual(reasons((yield* inbox(kousik)).items), ["added-to-space"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("lists a mention until the room is visited, and Done clears it early", () =>
  Effect.gen(function* () {
    yield* createSpace;
    yield* visitRoom(kousik);
    yield* TestClock.adjust("1 minute");
    const mention = (text: string) =>
      dispatch({
        type: "space.post",
        ...base,
        commandId: commandId("post"),
        actorId: hanad,
        messageId: MessageId.make(`message:${text}`),
        text,
        mentions: [{ type: "member", memberId: kousik }],
        authorKind: "user",
      });
    yield* mention("first");
    let items = (yield* inbox(kousik)).items;
    assert.deepStrictEqual(
      items.map((item) => [item.reason, item.group, item.actorId, item.excerpt]),
      [["mention", "for-you", hanad, "first"]],
    );
    // For you is listed, not counted.
    assert.equal((yield* inbox(kousik)).summary.needsYou, 0);
    // The author's own post is not for them.
    assert.notInclude(reasons((yield* inbox(hanad)).items), "mention");

    yield* TestClock.adjust("1 minute");
    yield* visitRoom(kousik);
    assert.deepStrictEqual((yield* inbox(kousik)).items, []);

    yield* TestClock.adjust("1 minute");
    yield* mention("second");
    const service = yield* InboxService.InboxService;
    items = (yield* inbox(kousik)).items;
    const error = yield* Effect.flip(
      service.snooze(
        { memberId: kousik },
        { itemId: items[0]!.id, until: "1970-01-02T00:00:00.000Z" },
      ),
    );
    assert.equal(error.reason, "not-snoozable");
    yield* service.dismiss({ memberId: kousik }, { itemId: items[0]!.id });
    assert.deepStrictEqual((yield* inbox(kousik)).items, []);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "refuses Done on a Needs you item, and snoozes a task item until its time or Unsnooze",
  () =>
    Effect.gen(function* () {
      const service = yield* InboxService.InboxService;
      yield* createSpace;
      yield* visitRoom(kousik);
      yield* createTask(rutvik, kousik);
      const [item] = (yield* inbox(kousik)).items;
      assert.equal(item?.reason, "task-assigned");
      const error = yield* Effect.flip(service.dismiss({ memberId: kousik }, { itemId: item!.id }));
      assert.equal(error.reason, "not-dismissable");

      yield* service.snooze(
        { memberId: kousik },
        { itemId: item!.id, until: "1970-01-01T02:00:00.000Z" },
      );
      const hidden = yield* inbox(kousik);
      assert.deepStrictEqual(hidden.items, []);
      assert.deepStrictEqual([hidden.summary.needsYou, hidden.summary.snoozed], [0, 1]);
      const snoozed = yield* service.list({ memberId: kousik }, { snoozed: true });
      assert.deepStrictEqual(
        snoozed.items.map((snoozedItem) => [snoozedItem.id, snoozedItem.snoozedUntil]),
        [[item!.id, "1970-01-01T02:00:00.000Z"]],
      );
      yield* TestClock.adjust("2 hours");
      assert.deepStrictEqual(reasons((yield* inbox(kousik)).items), ["task-assigned"]);
      assert.equal((yield* inbox(kousik)).summary.snoozed, 0);

      yield* service.snooze(
        { memberId: kousik },
        { itemId: item!.id, until: "1970-01-01T05:00:00.000Z" },
      );
      const before = (yield* inbox(kousik)).summary.revision;
      yield* service.unsnooze({ memberId: kousik }, { itemId: item!.id });
      const after = yield* inbox(kousik);
      assert.deepStrictEqual(reasons(after.items), ["task-assigned"]);
      assert.equal(after.summary.snoozed, 0);
      assert.notEqual(after.summary.revision, before);
      assert.deepStrictEqual(
        (yield* service.list({ memberId: kousik }, { snoozed: true })).items,
        [],
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("says who added the member until they open the room, and drops archived spaces", () =>
  Effect.gen(function* () {
    yield* createSpace;
    yield* createTask(rutvik, kousik);
    assert.deepStrictEqual(
      (yield* inbox(kousik)).items
        .filter((item) => item.reason === "added-to-space")
        .map((item) => [item.actorId, item.spaceName]),
      [[rutvik, "Question creation"]],
    );
    yield* dispatch({
      type: "space.archive",
      ...base,
      commandId: commandId("archive"),
      actorId: rutvik,
    });
    const archived = yield* inbox(kousik);
    assert.deepStrictEqual([archived.items, archived.summary.needsYou], [[], 0]);
  }).pipe(Effect.provide(layer)),
);

it.effect("pages newest first with an opaque cursor", () =>
  Effect.gen(function* () {
    yield* createSpace;
    yield* createTask(rutvik, kousik);
    const service = yield* InboxService.InboxService;
    const all = (yield* inbox(kousik)).items;
    assert.equal(all.length, 2);
    const first = yield* service.list({ memberId: kousik }, { limit: 1 });
    assert.notEqual(first.nextCursor, null);
    const second = yield* service.list(
      { memberId: kousik },
      { limit: 1, cursor: first.nextCursor! },
    );
    assert.deepStrictEqual([...first.items, ...second.items], all);
    assert.equal(second.nextCursor, null);
    const needsYou = yield* service.list({ memberId: kousik }, { group: "needs-you" });
    assert.deepStrictEqual(reasons(needsYou.items), ["task-assigned"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("streams the summary now, then each change", () =>
  Effect.gen(function* () {
    yield* createSpace;
    const service = yield* InboxService.InboxService;
    const summaries = yield* Queue.unbounded<number>();
    const fiber = yield* service.subscribeSummary({ memberId: kousik }).pipe(
      Stream.runForEach((summary) => Queue.offer(summaries, summary.needsYou)),
      Effect.forkChild,
    );
    assert.equal(yield* Queue.take(summaries), 0);
    yield* createTask(rutvik, kousik);
    assert.equal(yield* Queue.take(summaries), 1);
    yield* Fiber.interrupt(fiber);
  }).pipe(Effect.provide(layer)),
);

it.effect("lists the owner's closed tasks newest first, never others' or an archived space's", () =>
  Effect.gen(function* () {
    const service = yield* InboxService.InboxService;
    const close = (taskId: SpaceTaskId, status: "done" | "canceled") =>
      dispatch({
        type: "space.task.update",
        ...base,
        commandId: commandId("close"),
        actorId: kousik,
        taskId,
        change: {
          type: "status",
          status,
          by: { type: "member", memberId: kousik },
          askedBy: null,
        },
      });
    const done = SpaceTaskId.make("stk_00000000000000000002");
    const canceled = SpaceTaskId.make("stk_00000000000000000003");
    const theirs = SpaceTaskId.make("stk_00000000000000000004");
    yield* createSpace;
    yield* createTask(rutvik, kousik);
    yield* createTask(kousik, kousik, done);
    yield* createTask(kousik, kousik, canceled);
    yield* createTask(rutvik, rutvik, theirs);
    yield* close(done, "done");
    yield* TestClock.adjust("1 minute");
    yield* close(canceled, "canceled");
    yield* dispatch({
      type: "space.task.update",
      ...base,
      commandId: commandId("close-theirs"),
      actorId: rutvik,
      taskId: theirs,
      change: {
        type: "status",
        status: "done",
        by: { type: "member", memberId: rutvik },
        askedBy: null,
      },
    });

    const closed = yield* service.closedTasks({ memberId: kousik });
    assert.deepStrictEqual(
      closed.tasks.map((closedTask) => [closedTask.id, closedTask.status]),
      [
        [canceled, "canceled"],
        [done, "done"],
      ],
    );
    yield* dispatch({
      type: "space.archive",
      ...base,
      commandId: commandId("archive"),
      actorId: rutvik,
    });
    assert.deepStrictEqual((yield* service.closedTasks({ memberId: kousik })).tasks, []);
  }).pipe(Effect.provide(layer)),
);

it.effect("shares a teammate's local thread with the team only where access isn't enforced", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:local");
    const sharedWithHanad = Effect.gen(function* () {
      yield* dispatch({
        type: "thread.create",
        commandId: commandId("thread"),
        actorId: kousik,
        threadId,
        projectId,
        title: "Local work",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
        ownerId: kousik,
      });
      const service = yield* InboxService.InboxService;
      const shared = yield* service.sharedWithYou({ memberId: hanad }, {});
      // Never shared by name, so never an Inbox item.
      assert.notInclude(reasons((yield* inbox(hanad)).items), "shared-with-you");
      assert.deepStrictEqual((yield* service.sharedWithYou({ memberId: kousik }, {})).items, []);
      return shared.items.map((item): ReadonlyArray<string> => [
        item.threadId,
        item.ownerId,
        item.via,
      ]);
    });
    const cases: ReadonlyArray<
      readonly [Layer.Layer<ThreadAccess.ThreadAccess>, ReadonlyArray<ReadonlyArray<string>>]
    > = [
      [ThreadAccess.layerTest(), [[threadId, kousik, "team"]]],
      [ThreadAccess.layerTest({ serverOwnerId: rutvik }), []],
    ];
    for (const [access, expected] of cases) {
      assert.deepStrictEqual(
        yield* sharedWithHanad.pipe(
          Effect.provide(
            Layer.provideMerge(
              InboxService.layer,
              Layer.merge(Layer.merge(layerOrchestration, layerBotService), access),
            ),
          ),
        ),
        expected,
      );
    }
  }),
);

const owner = { memberId: rutvik };

/** A real thread with a pending runtime request, so the Inbox's request source finds it. */
const requestOn = (
  threadId: ThreadId,
  ownerId: MemberId,
  kind: "user_input" | "command" = "user_input",
) =>
  Effect.gen(function* () {
    yield* dispatch({
      type: "thread.create",
      commandId: commandId("thread"),
      actorId: ownerId,
      threadId,
      projectId,
      title: "Upgrade server",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      ownerId,
    });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const requestId = RuntimeRequestId.make(`request:${threadId}`);
    const nodeId = NodeId.make(`node:${threadId}`);
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:request`),
      type: "runtime-request.updated",
      threadId,
      nodeId,
      occurredAt: now,
      payload: {
        id: requestId,
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind,
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      },
    });
    return requestId;
  });

it.effect("shows a bot's open ask to its owner, and never to another member", () =>
  Effect.gen(function* () {
    BotThreads.reset();
    BotEscalations.reset();
    const bots = yield* BotService.BotService;
    const bot = yield* bots.create(owner, { name: "Atlas", charter: "", starter: "blank" });
    const ask = yield* bots.createAsk(bot.id, {
      jobId: null,
      question: "Per member or per token?",
      why: "It changes the model.",
      options: [],
      pick: null,
    });
    const mine = (yield* inbox(rutvik)).items.filter((item) => item.reason === "bot-ask");
    assert.deepStrictEqual(
      mine.map((item) => [item.botName, item.botColor, item.askId, item.excerpt, item.group]),
      [["Atlas", bot.color, ask.id, "Per member or per token?", "needs-you"]],
    );
    assert.notInclude(reasons((yield* inbox(kousik)).items), "bot-ask");
  }).pipe(Effect.provide(layer)),
);

it.effect("hides a bot session's request until it escalates, then shows the bot and job", () =>
  Effect.gen(function* () {
    BotThreads.reset();
    BotEscalations.reset();
    const bots = yield* BotService.BotService;
    const bot = yield* bots.create(owner, { name: "Atlas", charter: "", starter: "blank" });
    const job = yield* bots.createJob(owner, { botId: bot.id, request: "Upgrade server" });
    const threadId = ThreadId.make("thread:bot-session");
    yield* bots.addSession({
      threadId,
      botId: bot.id,
      jobId: job.id,
      role: "worker",
      title: "Upgrade server",
      projectId,
      takenOver: false,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });
    const requestId = yield* requestOn(threadId, rutvik);
    assert.notInclude(reasons((yield* inbox(rutvik)).items), "question");

    BotEscalations.mark(threadId, requestId);
    const escalated = (yield* inbox(rutvik)).items.filter((item) => item.threadId === threadId);
    assert.deepStrictEqual(
      escalated.map((item) => [
        item.reason,
        item.botName,
        item.botColor,
        item.jobId,
        item.jobNumber,
        item.jobTitle,
      ]),
      [["question", "Atlas", bot.color, job.id, 1, "Upgrade server"]],
    );

    // Handing it back keeps its requests out of the Inbox until the bot leaves one unanswered again.
    BotEscalations.clear(threadId, requestId);
    assert.notInclude(reasons((yield* inbox(rutvik)).items), "question");
    yield* bots.setSessionTakenOver(threadId, true);
    assert.include(reasons((yield* inbox(rutvik)).items), "question");
  }).pipe(Effect.provide(layer)),
);

it.effect("never lists a bot home thread's request, escalated or not", () =>
  Effect.gen(function* () {
    BotThreads.reset();
    BotEscalations.reset();
    const bots = yield* BotService.BotService;
    const bot = yield* bots.create(owner, { name: "Atlas", charter: "", starter: "blank" });
    const homeThreadId = ThreadId.make("thread:bot-home");
    yield* bots.setHome(bot.id, { homeThreadId, homeProjectId: projectId });
    const requestId = yield* requestOn(homeThreadId, rutvik);
    assert.notInclude(reasons((yield* inbox(rutvik)).items), "question");
    BotEscalations.mark(homeThreadId, requestId);
    assert.notInclude(reasons((yield* inbox(rutvik)).items), "question");
  }).pipe(Effect.provide(layer)),
);
