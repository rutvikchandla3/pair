import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MemberId,
  MessageId,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SPACE_AGENT_DRIVER,
  SPACE_AGENT_INSTANCE_ID,
  SpaceId,
  type SpaceNoteChange,
  SpaceTaskId,
  type SpacePairVia,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { spaceActionIdFor } from "./SpaceAgentDecisions.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Spaces never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const pairAdapter = {
  ...adapter,
  instanceId: SPACE_AGENT_INSTANCE_ID,
  driver: SPACE_AGENT_DRIVER,
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
// The Orchestrator alone: `SpaceService` and the MCP toolkit are tested beside them.
const layer = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "spaces" },
    ProviderAdapterRegistry.layerFromAdapters([adapter, pairAdapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const rutvik = MemberId.make("member:rutvik");
const kousik = MemberId.make("member:kousik");
const hanad = MemberId.make("member:hanad");
const spaceId = SpaceId.make("spc_0123456789abcdef0123");
const roomThreadId = ThreadId.make("thread:room");
const projectId = ProjectId.make("project:spaces");
const base = { spaceId, threadId: roomThreadId } as const;

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
  memberIds: [kousik],
  modelSelection,
});

const post = (
  actorId: MemberId,
  text: string,
  options: Partial<Extract<OrchestrationV2ServerCommand, { type: "space.post" }>> = {},
) => {
  const id = commandId("post");
  return dispatch({
    type: "space.post",
    ...base,
    commandId: id,
    actorId,
    messageId: MessageId.make(`message:${id}`),
    text,
    mentions: [],
    authorKind: "user",
    ...options,
  });
};

const task = (id: string) => SpaceTaskId.make(`stk_${id.padStart(20, "0")}`);

const createTask = (
  actorId: MemberId,
  taskId: SpaceTaskId,
  options: Partial<Extract<OrchestrationV2ServerCommand, { type: "space.task.create" }>> = {},
) =>
  dispatch({
    type: "space.task.create",
    ...base,
    commandId: commandId("task"),
    actorId,
    taskId,
    title: "Preview renderer",
    description: "Fix the preview renderer",
    ownerId: kousik,
    status: "todo",
    ...options,
  });

const updateTask = (
  actorId: MemberId,
  taskId: SpaceTaskId,
  change: Extract<OrchestrationV2ServerCommand, { type: "space.task.update" }>["change"],
) =>
  dispatch({
    type: "space.task.update",
    ...base,
    commandId: commandId("update"),
    actorId,
    taskId,
    change,
  });

const createThread = (threadId: ThreadId, ownerId: MemberId) =>
  dispatch({
    type: "thread.create",
    commandId: commandId("thread"),
    actorId: ownerId,
    threadId,
    projectId,
    title: "Work",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
    ownerId,
  });

const linkThread = (
  threadId: ThreadId,
  actorId: MemberId,
  target: { readonly spaceId: SpaceId; readonly taskId: SpaceTaskId } | null,
) =>
  dispatch({
    type: "space.thread.link",
    commandId: commandId("link"),
    threadId,
    actorId,
    target,
    via: "attach",
  });

/** Each stored event's type and stream, in commit order. */
const streams = (result: Orchestrator.OrchestratorV2DispatchResult) =>
  result.storedEvents.map(({ event }) => [event.type, event.threadId] as const);

/** The refusal reason the Orchestrator put in the error's cause. */
const refusal = <A, E>(effect: Effect.Effect<A, E, Orchestrator.OrchestratorV2>) =>
  Effect.flip(effect).pipe(
    Effect.map((error) => {
      const cause = (error as { readonly cause?: unknown }).cause;
      return String(cause ?? error);
    }),
  );

/** The reply runs a tag queued on the room thread: its trigger post and provider instance. */
const pairRuns = Effect.flatMap(ProjectionStore.ProjectionStoreV2, (projections) =>
  projections.getThreadProjection(roomThreadId),
).pipe(
  Effect.map((projection) =>
    projection.runs.map((run) => [run.userMessageId, run.providerInstanceId] as const),
  ),
);

it.layer(layer)("space orchestration", (it) => {
  it.effect("creates the room, posts, queues @pair for people only, and archives", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createSpace;

      const room = yield* projections.getThread(roomThreadId);
      assert.deepStrictEqual(room.space, {
        kind: "room",
        spaceId,
        revision: "1970-01-01T00:00:00.000Z",
        latestEntry: { by: rutvik, at: "1970-01-01T00:00:00.000Z" },
      });
      assert.strictEqual(room.ownerId, rutvik);
      const space = yield* projections.getSpace(spaceId);
      assert.deepStrictEqual(
        space?.members.map((member) => member.memberId),
        [rutvik, kousik],
      );
      assert.deepStrictEqual(
        (yield* projections.listSpaces(kousik)).map((s) => s.id),
        [spaceId],
      );
      assert.deepStrictEqual(yield* projections.listSpaces(hanad), []);

      const tagged = commandId("tag");
      yield* dispatch({
        type: "space.post",
        ...base,
        commandId: tagged,
        actorId: kousik,
        messageId: MessageId.make("message:tag"),
        text: "@pair what's left?",
        mentions: [{ type: "pair" }, { type: "member" as const, memberId: hanad }],
        authorKind: "user",
      });
      assert.deepStrictEqual(yield* pairRuns, [
        [MessageId.make("message:tag"), SPACE_AGENT_INSTANCE_ID],
      ]);
      const effects = yield* Effect.flatMap(EffectOutbox.EffectOutboxV2, (outbox) =>
        outbox.listByCommandId(tagged),
      );
      assert.deepStrictEqual(
        effects.map((effect) => effect.request.type),
        ["provider-turn.start"],
      );

      const fromAgent = commandId("agent");
      yield* dispatch({
        type: "space.post",
        ...base,
        commandId: fromAgent,
        actorId: kousik,
        messageId: MessageId.make("message:agent"),
        text: "@pair loop",
        mentions: [{ type: "pair" }],
        authorKind: "agent",
      });
      assert.strictEqual((yield* pairRuns).length, 1);

      yield* post(rutvik, "Replying", { quoteEntryId: MessageId.make("message:tag") });
      const entries = yield* projections.listSpaceRoomEntries({ spaceId, limit: 10 });
      const tag = entries.find((entry) => entry.id === "message:tag");
      // Hanad is not a member, so his mention is dropped and he is never notified.
      assert.deepStrictEqual(tag?.type === "post" ? tag.mentions : null, [{ type: "pair" }]);
      const reply = entries.at(-1);
      assert.strictEqual(reply?.type === "post" ? reply.quote?.entryId : null, "message:tag");
      assert.deepStrictEqual(
        entries.map((entry) => (entry.type === "system" ? entry.line.type : entry.authorKind)),
        ["created", "user", "agent", "user"],
      );

      const outsider = yield* refusal(post(hanad, "let me in"));
      assert.include(outsider, "not-member");

      const byMember = yield* refusal(
        dispatch({ type: "space.archive", ...base, commandId: commandId("a"), actorId: kousik }),
      );
      assert.include(byMember, "not-owner");
      yield* dispatch({
        type: "space.archive",
        ...base,
        commandId: commandId("a"),
        actorId: rutvik,
      });
      assert.include(yield* refusal(post(kousik, "late")), "archived");
      yield* dispatch({
        type: "space.unarchive",
        ...base,
        commandId: commandId("u"),
        actorId: rutvik,
      });
      yield* post(kousik, "back");
    }),
  );

  it.effect(
    "tasks live on the room stream; a link writes the thread and each room it touches",
    () =>
      Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const preview = task("1");
        yield* createTask(rutvik, preview);
        assert.deepInclude(yield* projections.getSpaceTask(preview), {
          ownerId: kousik,
          assignedBy: rutvik,
          status: "todo",
        });
        assert.include(yield* refusal(createTask(rutvik, preview)), "already-exists");
        assert.include(
          yield* refusal(createTask(rutvik, task("2"), { ownerId: hanad })),
          "not-a-target-member",
        );

        // A task write bumps the room's revision, so every member's sidebar refetches.
        yield* TestClock.adjust("1 hour");
        const moved = yield* updateTask(kousik, preview, {
          type: "status",
          status: "in-progress",
          by: { type: "member", memberId: kousik },
          askedBy: null,
        });
        assert.deepStrictEqual(streams(moved), [
          ["space.task.updated", roomThreadId],
          ["space.room-entry", roomThreadId],
        ]);
        const room = yield* projections.getThread(roomThreadId);
        assert.strictEqual(
          room.space?.kind === "room" ? room.space.revision : null,
          "1970-01-01T01:00:00.000Z",
        );
        assert.include(
          yield* refusal(updateTask(kousik, preview, { type: "remind" })),
          "not-task-creator",
        );
        yield* updateTask(kousik, preview, { type: "hand-back", reason: "On leave this week" });
        assert.deepInclude(yield* projections.getSpaceTask(preview), {
          ownerId: rutvik,
          assignedBy: null,
        });

        // Attach: the thread's own stream and the room's, in one commit.
        const work = ThreadId.make("thread:work");
        yield* createThread(work, kousik);
        assert.include(
          yield* refusal(linkThread(work, rutvik, { spaceId, taskId: preview })),
          "not-thread-owner",
        );
        const attached = yield* linkThread(work, kousik, { spaceId, taskId: preview });
        assert.deepStrictEqual(streams(attached), [
          ["thread.metadata-updated", work],
          ["space.room-entry", roomThreadId],
        ]);
        const linked = yield* projections.getThread(work);
        assert.deepInclude(linked.space, {
          kind: "task",
          spaceId,
          taskId: preview,
          linkedBy: kousik,
        });
        assert.deepStrictEqual(yield* projections.listSpaceTaskThreadIdsFor(preview), [work]);
        assert.deepStrictEqual(
          (yield* projections.listSpaceTaskEntries({ taskId: preview, limit: 10 })).map((entry) =>
            entry.type === "system" ? entry.line.type : entry.type,
          ),
          ["task-created", "task-status", "task-handed-back", "task-thread-added"],
        );

        // Move to another space's task: a line leaves the old room and one joins the new.
        const otherSpace = SpaceId.make("spc_00000000000000000b0b");
        const otherRoom = ThreadId.make("thread:other-room");
        yield* dispatch({
          type: "space.create",
          spaceId: otherSpace,
          threadId: otherRoom,
          commandId: commandId("create"),
          actorId: kousik,
          createdBy: "user",
          creationSource: "web",
          name: "Other",
          brief: "",
          repositoryIds: [projectId],
          projectId,
          memberIds: [],
          modelSelection,
        });
        const elsewhere = task("3");
        yield* dispatch({
          type: "space.task.create",
          spaceId: otherSpace,
          threadId: otherRoom,
          commandId: commandId("task"),
          actorId: kousik,
          taskId: elsewhere,
          title: "Elsewhere",
          description: "In the other space",
          ownerId: kousik,
          status: "todo",
        });
        const movedAcross = yield* linkThread(work, kousik, {
          spaceId: otherSpace,
          taskId: elsewhere,
        });
        assert.deepStrictEqual(streams(movedAcross), [
          ["thread.metadata-updated", work],
          ["space.room-entry", roomThreadId],
          ["space.room-entry", otherRoom],
        ]);
        assert.deepStrictEqual(yield* projections.listSpaceTaskThreadIdsFor(preview), []);
        assert.deepStrictEqual(yield* projections.listSpaceTaskThreadIdsFor(elsewhere), [work]);

        // Detach removes the key.
        const detached = yield* linkThread(work, kousik, null);
        assert.deepStrictEqual(streams(detached), [
          ["thread.metadata-updated", work],
          ["space.room-entry", otherRoom],
        ]);
        assert.isUndefined((yield* projections.getThread(work)).space);
        assert.deepStrictEqual(streams(yield* linkThread(work, kousik, null)), []);
      }),
  );

  it.effect("removing a member with reassignTo moves each open task in that commit", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* dispatch({
        type: "space.member.add",
        ...base,
        commandId: commandId("add"),
        actorId: rutvik,
        memberIds: [hanad, kousik],
      });
      const open = [task("10"), task("11")];
      const done = task("12");
      for (const taskId of [...open, done]) yield* createTask(rutvik, taskId, { ownerId: hanad });
      yield* updateTask(hanad, done, {
        type: "status",
        status: "done",
        by: { type: "member", memberId: hanad },
        askedBy: null,
      });
      const removed = yield* dispatch({
        type: "space.member.remove",
        ...base,
        commandId: commandId("remove"),
        actorId: rutvik,
        memberId: hanad,
        reassignTo: kousik,
      });
      const updated = removed.storedEvents.flatMap(({ event }) =>
        event.type === "space.task.updated" ? [event.payload.id] : [],
      );
      assert.deepStrictEqual(updated.toSorted(), open);
      const line = removed.storedEvents.flatMap(({ event }) =>
        event.type === "space.room-entry" && event.payload.type === "system"
          ? [event.payload.line]
          : [],
      );
      assert.deepStrictEqual(line, [
        { type: "member-removed", memberId: hanad, reassignedTo: kousik, tasks: 2 },
      ]);
      for (const taskId of open) {
        assert.strictEqual((yield* projections.getSpaceTask(taskId))?.ownerId, kousik);
      }
      assert.strictEqual((yield* projections.getSpaceTask(done))?.ownerId, hanad);
    }),
  );
  it.effect("members: owner-only adds, Undo restores joinedAt, owner must transfer to leave", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const act = (command: Record<string, unknown> & { type: string }, actorId: MemberId) =>
        dispatch({
          ...base,
          commandId: commandId(command.type),
          actorId,
          ...command,
        } as OrchestrationV2ServerCommand);

      const membership = (result: Orchestrator.OrchestratorV2DispatchResult) =>
        result.storedEvents.flatMap(({ event }) =>
          event.type === "space.updated" ? [event.membership ?? null] : [],
        );
      assert.include(
        yield* refusal(act({ type: "space.member.add", memberIds: [hanad] }, kousik)),
        "not-owner",
      );
      assert.deepStrictEqual(membership(yield* act({ type: "space.join.request" }, hanad)), [null]);
      assert.deepStrictEqual(
        (yield* projections.getSpace(spaceId))?.joinRequests.map((r) => r.memberId),
        [hanad],
      );
      assert.deepStrictEqual(
        membership(yield* act({ type: "space.member.add", memberIds: [hanad] }, rutvik)),
        [{ added: [hanad], removed: [] }],
      );
      const added = yield* projections.getSpace(spaceId);
      assert.deepStrictEqual(added?.joinRequests, []);
      const joinedAt = added?.members.find((m) => m.memberId === hanad)?.joinedAt;

      assert.deepStrictEqual(
        membership(yield* act({ type: "space.member.remove", memberId: hanad }, rutvik)),
        [{ added: [], removed: [hanad] }],
      );
      assert.deepStrictEqual(yield* projections.listSpaces(hanad), []);
      yield* act({ type: "space.member.add", memberIds: [hanad], restore: true }, rutvik);
      const restored = yield* projections.getSpace(spaceId);
      assert.strictEqual(restored?.members.find((m) => m.memberId === hanad)?.joinedAt, joinedAt);

      assert.include(yield* refusal(act({ type: "space.leave" }, rutvik)), "owner-cannot-leave");
      yield* act({ type: "space.owner.transfer", ownerId: kousik }, rutvik);
      yield* act({ type: "space.leave" }, rutvik);
      const after = yield* projections.getSpace(spaceId);
      assert.strictEqual(after?.ownerId, kousik);
      assert.deepStrictEqual(yield* projections.listSpaces(rutvik), []);
    }),
  );

  it.effect("Pair's records: notes receipts, tombstones, one task per reply, never steering", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const pairSpace = SpaceId.make("spc_00000000000000000a1e");
      const pairRoom = ThreadId.make("thread:pair-room");
      const at = { spaceId: pairSpace, threadId: pairRoom } as const;
      yield* dispatch({
        type: "space.create",
        ...at,
        commandId: commandId("create"),
        actorId: rutvik,
        createdBy: "user",
        creationSource: "web",
        name: "Pair",
        brief: "",
        repositoryIds: [projectId],
        projectId,
        memberIds: [kousik],
        modelSelection,
      });
      const tagId = MessageId.make("message:pair-tag");
      yield* dispatch({
        type: "space.post",
        ...at,
        commandId: commandId("tag"),
        actorId: kousik,
        messageId: tagId,
        text: "@pair we're going with SQLite, note it",
        mentions: [{ type: "pair" }],
        authorKind: "user",
      });
      const run = (yield* projections.getThreadProjection(pairRoom)).runs.at(-1)!;
      assert.strictEqual(run.userMessageId, tagId);
      const via = { runId: run.id, roomMessageId: tagId };
      const notes = (
        changes: ReadonlyArray<SpaceNoteChange>,
        by: SpacePairVia | null,
        actorId = kousik,
      ) =>
        dispatch({
          type: "space.notes.edit",
          ...at,
          commandId: commandId("notes"),
          actorId,
          changes,
          via: by,
        });
      const add = {
        op: "add",
        section: "decision",
        text: "Use SQLite",
        sourceIds: [tagId],
      } as const;

      yield* notes([add], via);
      yield* notes([{ ...add, text: "Postgres later" }], via);
      const [item, later] = yield* projections.listSpaceNotes(pairSpace);
      // One receipt per reply: the second edit merges into it.
      const receipt = yield* projections.getSpaceAction(spaceActionIdFor(tagId, "notes"));
      assert.strictEqual(receipt?.state, "done");
      assert.deepStrictEqual(
        receipt?.outcome?.type === "notes.changed" ? receipt.outcome.changes.map((c) => c.op) : [],
        ["add", "add"],
      );
      assert.include(yield* refusal(notes([add], via, rutvik)), "not-tagger");
      assert.include(
        yield* refusal(notes([{ op: "edit", noteId: item!.id, version: 2, text: "x" }], null)),
        "note-stale",
      );

      // A person removes it; Pair may not bring it back from the same post unless asked.
      yield* notes([{ op: "remove", noteId: item!.id, version: 1 }], null, rutvik);
      assert.include(yield* refusal(notes([add], via)), "removed-source");
      yield* notes([{ ...add, restoreRemoved: true }], via);

      // Undo reverts Pair's items, leaving the ones a person edited or removed since.
      yield* notes([{ op: "edit", noteId: later!.id, version: 1, text: "Postgres in Q3" }], null);
      yield* dispatch({
        type: "space.action.undo",
        ...at,
        commandId: commandId("undo"),
        actorId: kousik,
        actionId: receipt!.id,
      });
      const undone = yield* projections.getSpaceAction(receipt!.id);
      assert.strictEqual(undone?.state, "undone");
      assert.deepStrictEqual(undone?.undo?.notUndone, [item!.id, later!.id]);
      assert.deepStrictEqual(
        (yield* projections.listSpaceNotes(pairSpace)).map((note) => note.text),
        ["Postgres in Q3"],
      );

      const pairTask = task("a1e");
      const createdId = spaceActionIdFor(tagId, "task-1");
      const createByPair = (taskId: SpaceTaskId, key: string) =>
        dispatch({
          type: "space.task.create",
          ...at,
          commandId: commandId("pair-task"),
          actorId: kousik,
          taskId,
          title: "Migrate to SQLite",
          description: "Move the store to SQLite",
          ownerId: kousik,
          status: "todo",
          via,
          spaceActionId: spaceActionIdFor(tagId, key),
        });
      yield* createByPair(pairTask, "task-1");
      assert.deepInclude((yield* projections.getSpaceAction(createdId))?.outcome, {
        type: "task.created",
        taskId: pairTask,
        threadId: null,
        started: false,
      });
      assert.include(yield* refusal(createByPair(task("a1f"), "task-2")), "over-limit");
      // Only the tagger marks it started; the record names the thread they started on it.
      const pairThreadId = ThreadId.make("thread:pair-task");
      yield* createThread(pairThreadId, kousik);
      yield* dispatch({
        type: "space.thread.link",
        commandId: commandId("link"),
        threadId: pairThreadId,
        actorId: kousik,
        target: { spaceId: pairSpace, taskId: pairTask },
        via: "start",
      });
      const started = (actorId: MemberId) =>
        dispatch({
          type: "space.action.started",
          ...at,
          commandId: commandId("pair-started"),
          actorId,
          actionId: createdId,
        });
      assert.include(yield* refusal(started(rutvik)), "not-tagger");
      yield* started(kousik);
      assert.deepInclude((yield* projections.getSpaceAction(createdId))?.outcome, {
        type: "task.created",
        threadId: pairThreadId,
        started: true,
      });

      const steer = (
        dispatchMode: { type: "start_immediately" } | { type: "queue_after_active" },
      ) =>
        dispatch({
          type: "message.dispatch",
          commandId: commandId("pair-message"),
          actorId: kousik,
          threadId: pairThreadId,
          messageId: MessageId.make(`message:${counter}`),
          text: "Also drop the old tables",
          attachments: [],
          createdBy: "user",
          creationSource: "server",
          dispatchMode,
          deliveryIntent: "steer",
          via: { pair: via },
        });
      assert.include(
        yield* refusal(steer({ type: "start_immediately" })),
        "refused a message from @pair: not-allowed",
      );
      assert.include(
        yield* refusal(steer({ type: "queue_after_active" })),
        "refused a message from @pair: not-allowed",
      );

      // Undo of the created task deletes it while untouched, and archives the thread it started.
      const deleted = yield* dispatch({
        type: "space.task.update",
        ...at,
        commandId: commandId("delete"),
        actorId: kousik,
        taskId: pairTask,
        change: { type: "delete" },
      });
      assert.deepStrictEqual(streams(deleted), [
        ["space.task.updated", pairRoom],
        ["thread.archived", pairThreadId],
      ]);
      assert.isNotNull((yield* projections.getSpaceTask(pairTask))?.deletedAt);
      const archived = yield* projections.getThread(pairThreadId);
      assert.isNotNull(archived.archivedAt);
      assert.isUndefined(archived.space);

      // A thread Pair starts for the tagger records its action in the link's commit.
      const ownTask = task("a20");
      yield* dispatch({
        type: "space.task.create",
        ...at,
        commandId: commandId("task"),
        actorId: kousik,
        taskId: ownTask,
        title: "Seed roles",
        description: "Seed the role catalog",
        ownerId: kousik,
        status: "todo",
      });
      const startedThreadId = ThreadId.make("thread:pair-started");
      yield* createThread(startedThreadId, kousik);
      const startId = spaceActionIdFor(tagId, "start-1");
      const startedLink = yield* dispatch({
        type: "space.thread.link",
        commandId: commandId("link"),
        threadId: startedThreadId,
        actorId: kousik,
        target: { spaceId: pairSpace, taskId: ownTask },
        via: "start",
        pairVia: via,
        spaceActionId: startId,
      });
      assert.deepStrictEqual(streams(startedLink), [
        ["thread.metadata-updated", startedThreadId],
        ["space.room-entry", pairRoom],
        ["space.action.updated", pairRoom],
      ]);
      assert.deepInclude(yield* projections.getSpaceAction(startId), {
        state: "done",
        actorId: kousik,
        outcome: {
          type: "thread.started",
          taskId: ownTask,
          threadId: startedThreadId,
          title: "Seed roles",
        },
      });
    }),
  );
});
