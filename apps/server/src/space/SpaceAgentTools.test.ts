import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MemberId,
  MessageId,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  SPACE_AGENT_DRIVER,
  SPACE_AGENT_INSTANCE_ID,
  SpaceId,
  SpaceTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import type * as Members from "../persistence/Members.ts";
import { TeamState } from "../team/TeamState.ts";
import { SpaceAgentTools, SpaceContext, type SpaceReplyScope } from "./SpaceAgentRuntime.ts";
import * as SpaceAgentToolsLive from "./SpaceAgentTools.ts";
import * as SpaceContextLive from "./SpaceContext.ts";
import * as SpaceIntake from "./SpaceIntake.ts";
import * as SpaceService from "./SpaceService.ts";
import * as SpaceWorkspaces from "./SpaceWorkspaces.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const kousiksAccount = { instanceId: ProviderInstanceId.make("kousik-claude"), model: "claude" };
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

const rutvik = MemberId.make("member:rutvik");
const kousik = MemberId.make("member:kousik");
const projectId = ProjectId.make("project:spaces");
const record = (id: MemberId, name: string): [MemberId, Members.MemberRecord] => [
  id,
  {
    id,
    name: name as Members.MemberRecord["name"],
    role: "member",
    gitName: null,
    gitEmail: null,
    isOwner: false,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: null,
    removedAt: null,
  } as Members.MemberRecord,
];

const launched: Array<ThreadLaunch.ThreadLaunchRequest> = [];
const layerDatabase = SqlitePersistence.layerMemory;
const layerCore = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "space-agent" },
    ProviderAdapterRegistry.layerFromAdapters([adapter, pairAdapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);
/** Launch creates the thread (the link needs it) and records what it was asked. */
const layerLaunch = Layer.unwrap(
  Effect.map(Orchestrator.OrchestratorV2, (orchestrator) =>
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) =>
        input.title === "Will not start"
          ? Effect.fail(
              new ThreadLaunch.ThreadLaunchError({
                operation: "provision-worktree",
                commandId: input.commandId,
                projectId: input.projectId,
                cause: new Error("No machine is free."),
              }),
            )
          : orchestrator
              .dispatch({
                type: "thread.create",
                commandId: input.commandId,
                actorId: input.actorId!,
                threadId: input.threadId!,
                projectId: input.projectId,
                title: input.title!,
                modelSelection: input.modelSelection!,
                runtimeMode: input.runtimeMode ?? "full-access",
                interactionMode: input.interactionMode ?? "default",
                branch: null,
                worktreePath: null,
                createdBy: "user",
                creationSource: "web",
                ownerId: input.ownerId!,
              })
              .pipe(
                Effect.orDie,
                Effect.map(() => {
                  launched.push(input);
                  return {
                    threadId: input.threadId!,
                    resumed: false,
                  } as ThreadLaunch.ThreadLaunchResult;
                }),
              ),
    }),
  ),
).pipe(Layer.provide(layerCore));
const layerSupport = Layer.mergeAll(
  IdAllocator.layer,
  NodeCrypto.layer,
  SpaceIntake.layerDirect.pipe(Layer.provide(layerCore)),
  layerLaunch,
  Layer.mock(SpaceWorkspaces.SpaceWorkspaces)({}),
  Layer.mock(TeamState)({
    ownerId: rutvik,
    members: Ref.makeUnsafe<ReadonlyMap<MemberId, Members.MemberRecord>>(
      new Map([record(rutvik, "Rutvik"), record(kousik, "Kousik")]),
    ),
  }),
);
const layerSettings = ServerSettings.layerTest(
  {
    providerInstances: {
      [kousiksAccount.instanceId]: { driver: "claudeAgent", ownerMemberId: kousik },
    },
    defaultModelSelection: modelSelection,
  },
  { organization: "Acme", lockedSettings: [], limits: { maxRuntimeMode: "auto-accept-edits" } },
);
const layerTools = SpaceAgentToolsLive.layer.pipe(
  Layer.provideMerge(SpaceService.layer),
  Layer.provideMerge(layerSettings),
  Layer.provideMerge(layerCore),
  Layer.provideMerge(layerSupport),
);
const layer = SpaceContextLive.layer.pipe(Layer.provideMerge(layerTools));

let counter = 0;
const next = (label: string) => `${label}:${++counter}`;
const dispatch = (command: OrchestrationV2ServerCommand) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) => orchestrator.dispatch(command));

const createTask = (spaceId: SpaceId, roomThreadId: ThreadId, ownerId: MemberId, title: string) =>
  Effect.gen(function* () {
    const taskId = SpaceTaskId.make(`stk_${String(++counter).padStart(20, "0")}`);
    yield* dispatch({
      type: "space.task.create",
      commandId: CommandId.make(next("task")),
      threadId: roomThreadId,
      spaceId,
      actorId: rutvik,
      taskId,
      title,
      description: `Do ${title}`,
      ownerId,
      status: "todo",
    });
    return taskId;
  });

/** A thread `ownerId` attached to the task, and its first turn sent unless `selection` is given. */
const attachThread = (
  spaceId: SpaceId,
  taskId: SpaceTaskId,
  threadId: ThreadId,
  ownerId: MemberId,
  title: string,
  selection?: typeof kousiksAccount,
) =>
  Effect.gen(function* () {
    yield* dispatch({
      type: "thread.create",
      commandId: CommandId.make(next("thread")),
      actorId: ownerId,
      threadId,
      projectId,
      title,
      modelSelection: selection ?? modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      ownerId,
    });
    yield* dispatch({
      type: "space.thread.link",
      commandId: CommandId.make(next("link")),
      threadId,
      actorId: ownerId,
      target: { spaceId, taskId },
      via: "attach",
    });
    if (selection !== undefined) return;
    yield* dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(next("start")),
      threadId,
      actorId: ownerId,
      messageId: MessageId.make(next("message")),
      text: `Do ${title}`,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  });

/** A space with Rutvik (owner, tagger) and Kousik: his task with a thread, Kousik's with one, Kousik's without. */
const setup = Effect.gen(function* () {
  const n = String(++counter).padStart(4, "0");
  const spaceId = SpaceId.make(`spc_${n}${"0".repeat(16)}`);
  const roomThreadId = ThreadId.make(`thread:room-${n}`);
  yield* dispatch({
    type: "space.create",
    commandId: CommandId.make(next("space")),
    threadId: roomThreadId,
    spaceId,
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
  const tasks = {
    docs: yield* createTask(spaceId, roomThreadId, kousik, "Docs"),
    mine: yield* createTask(spaceId, roomThreadId, rutvik, "Preview renderer"),
    theirs: yield* createTask(spaceId, roomThreadId, kousik, "Invoices"),
  };
  const threads = {
    mine: ThreadId.make(`thread:mine-${n}`),
    theirs: ThreadId.make(`thread:theirs-${n}`),
  };
  yield* attachThread(spaceId, tasks.mine, threads.mine, rutvik, "Preview renderer");
  yield* attachThread(spaceId, tasks.theirs, threads.theirs, kousik, "Invoices");
  const post = (
    actorId: MemberId,
    text: string,
    authorKind: "user" | "agent" = "user",
    mentions: ReadonlyArray<{ readonly type: "pair" }> = [],
  ) =>
    Effect.gen(function* () {
      const messageId = MessageId.make(next("post"));
      yield* dispatch({
        type: "space.post",
        commandId: CommandId.make(next("post")),
        threadId: roomThreadId,
        spaceId,
        actorId,
        messageId,
        text,
        mentions,
        authorKind,
      });
      return messageId;
    });
  const reply = (roomMessageId: MessageId): SpaceReplyScope => ({
    spaceId,
    roomThreadId,
    runId: RunId.make(`run:${roomMessageId}`),
    taggerId: rutvik,
    roomMessageId,
  });
  const tools = yield* SpaceAgentTools;
  const call = (scope: SpaceReplyScope, name: string, input: unknown) =>
    tools.call(scope, name, input).pipe(
      Effect.map(
        (result) =>
          ({ ...JSON.parse(result.content), isError: result.isError }) as Record<
            string,
            unknown
          > & {
            readonly isError: boolean;
          },
      ),
    );
  return { spaceId, roomThreadId, tasks, threads, post, reply, call, n };
});

it.layer(layer)("@pair tools and context", (it) => {
  it.effect("create is idempotent on Retry; a second task in one reply is over_limit", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { spaceId, post, reply, call } = yield* setup;
      const scope = reply(yield* post(rutvik, "@pair make a task for Kousik", "user"));
      const input = { title: "Export CSV", description: "Export invoices as CSV.", owner: kousik };
      const taskIds = Effect.map(projections.listSpaceTasks(spaceId), (tasks) =>
        tasks.map((task) => task.id),
      );

      const created = yield* call(scope, "space_task_create", input);
      assert.strictEqual(created.status, "done");
      assert.strictEqual(created.started, false);
      const before = yield* taskIds;
      const retried = yield* call(
        { ...scope, runId: RunId.make("run:retry") },
        "space_task_create",
        input,
      );
      assert.strictEqual(retried.status, "already_done");
      assert.strictEqual((retried.outcome as { taskId: string }).taskId, created.taskId as string);
      assert.deepStrictEqual(yield* taskIds, before);

      const second = yield* call(scope, "space_task_create", { ...input, title: "Another" });
      assert.isTrue(second.isError);
      assert.strictEqual(second.reason, "over_limit");
      assert.deepStrictEqual(yield* taskIds, before);

      // startThread on someone else's task starts nothing.
      const forKousik = yield* call(
        reply(yield* post(rutvik, "@pair start one for Kousik")),
        "space_task_create",
        {
          ...input,
          title: "For Kousik",
          startThread: true,
        },
      );
      assert.strictEqual(forKousik.started, false);

      const ownScope = reply(yield* post(rutvik, "@pair one for me and start it"));
      const own = yield* call(ownScope, "space_task_create", {
        title: "Mine",
        description: "Mine.",
        startThread: true,
      });
      assert.strictEqual(own.started, true);
      const ownRecord = (yield* projections.listSpaceActions({
        roomMessageId: ownScope.roomMessageId,
      })).at(0);
      assert.deepInclude(ownRecord?.outcome, { type: "task.created", started: true });
      const shell = yield* projections.getThreadShell(launched.at(-1)!.threadId!);
      assert.deepInclude(shell?.space, { kind: "task", taskId: own.taskId as SpaceTaskId });
      const task = yield* projections.getSpaceTask(own.taskId as SpaceTaskId);
      assert.strictEqual(task?.status, "todo");
    }),
  );

  it.effect("a start never borrows another member's account and caps the runtime mode", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const { spaceId, n, tasks, post, reply, call } = yield* setup;
      // Rutvik's newest thread runs on Kousik's account, which never runs Rutvik's threads.
      yield* TestClock.adjust("1 minute");
      yield* attachThread(
        spaceId,
        tasks.mine,
        ThreadId.make(`thread:kousiks-account-${n}`),
        rutvik,
        "On Kousik's account",
        kousiksAccount,
      );

      yield* settings.updateSettings({ defaultModelSelection: null });
      const refused = yield* call(
        reply(yield* post(rutvik, "@pair start a thread on mine")),
        "space_thread_start",
        { taskId: tasks.mine },
      );
      const created = yield* call(
        reply(yield* post(rutvik, "@pair one for me and start it")),
        "space_task_create",
        { title: "Mine", description: "Mine.", startThread: true },
      );
      yield* settings.updateSettings({ defaultModelSelection: modelSelection });
      assert.isTrue(refused.isError);
      assert.strictEqual(refused.reason, "no_account");
      assert.strictEqual(created.status, "done");
      assert.strictEqual(created.started, false);

      const own = yield* call(
        reply(yield* post(rutvik, "@pair start a thread on mine")),
        "space_thread_start",
        { taskId: tasks.mine, prompt: "Start with the toolbar." },
      );
      assert.strictEqual(own.status, "done");
      assert.strictEqual(launched.at(-1)?.threadId, own.threadId as ThreadId);
      assert.deepStrictEqual(launched.at(-1)?.modelSelection, modelSelection);
      assert.strictEqual(launched.at(-1)?.runtimeMode, "auto-accept-edits");
      assert.strictEqual(launched.at(-1)?.initialMessage?.text, "Start with the toolbar.");
    }),
  );

  it.effect("a start that fails leaves the task created but not started", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { post, reply, call } = yield* setup;
      const scope = reply(yield* post(rutvik, "@pair one for me"));

      const created = yield* call(scope, "space_task_create", {
        title: "Will not start",
        description: "Nope.",
        startThread: true,
      });
      assert.strictEqual(created.status, "done");
      assert.strictEqual(created.started, false);
      assert.isNotNull(yield* projections.getSpaceTask(created.taskId as SpaceTaskId));
      const record = (yield* projections.listSpaceActions({
        roomMessageId: scope.roomMessageId,
      })).at(0);
      assert.deepInclude(record?.outcome, { type: "task.created", started: false });
    }),
  );

  it.effect("status moves only by name, once, and a move to the same status changes nothing", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { tasks, post, reply, call } = yield* setup;
      const scope = reply(yield* post(rutvik, "@pair mark invoices in review"));

      const moved = yield* call(scope, "space_task_status", {
        taskId: tasks.theirs,
        status: "in-review",
      });
      assert.deepInclude(moved, { status: "done", from: "todo", to: "in-review" });
      assert.strictEqual((yield* projections.getSpaceTask(tasks.theirs))?.status, "in-review");
      const again = yield* call(scope, "space_task_status", {
        taskId: tasks.theirs,
        status: "in-review",
      });
      assert.strictEqual(again.status, "already_done");
      const [record] = yield* projections.listSpaceActions({ roomMessageId: scope.roomMessageId });
      assert.deepInclude(record?.outcome, {
        type: "task.status.moved",
        from: "todo",
        to: "in-review",
      });

      const same = yield* call(
        reply(yield* post(rutvik, "@pair docs is to do")),
        "space_task_status",
        {
          taskId: tasks.docs,
          status: "todo",
        },
      );
      assert.strictEqual(same.status, "done");
      assert.include(same.note as string, "nothing changed");
    }),
  );

  it.effect("a reply makes at most five writes", () =>
    Effect.gen(function* () {
      const { threads, post, reply, call } = yield* setup;
      const scope = reply(yield* post(rutvik, "@pair do lots"));
      const created = yield* call(scope, "space_task_create", { title: "One", description: "1." });
      assert.strictEqual(created.status, "done");
      for (const text of ["a", "b", "c", "d"]) {
        const sent = yield* call(scope, "space_thread_message", { threadId: threads.mine, text });
        assert.isFalse(sent.isError);
      }
      const sixth = yield* call(scope, "space_thread_message", {
        threadId: threads.mine,
        text: "e",
      });
      assert.isTrue(sixth.isError);
      assert.strictEqual(sixth.reason, "over_limit");
    }),
  );

  it.effect("messages queue on your thread and wait for a confirm on another's", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { threads, post, reply, call } = yield* setup;
      const scope = reply(yield* post(rutvik, "@pair tell them"));

      const queued = yield* call(scope, "space_thread_message", {
        threadId: threads.mine,
        text: "Also handle dark mode.",
      });
      assert.strictEqual(queued.status, "done");
      const again = yield* call(scope, "space_thread_message", {
        threadId: threads.mine,
        text: "Also handle dark mode.",
      });
      assert.strictEqual(again.status, "already_done");
      const mine = yield* projections.getThreadProjection(threads.mine);
      const sent = mine.messages.filter((message) => message.via !== undefined);
      assert.deepStrictEqual(
        sent.map((message) => [message.text, message.authorId, message.via?.pair.roomMessageId]),
        [["Also handle dark mode.", rutvik, scope.roomMessageId]],
      );
      assert.strictEqual(
        mine.runs.find((run) => run.userMessageId === sent[0]!.id)?.status,
        "queued",
      );

      const proposed = yield* call(scope, "space_thread_message", {
        threadId: threads.theirs,
        text: "Use the new API.",
      });
      assert.strictEqual(proposed.status, "needs_confirmation");
      assert.strictEqual(proposed.ownerName, "Kousik");
      const actions = yield* projections.listSpaceActions({ roomMessageId: scope.roomMessageId });
      assert.deepStrictEqual(
        actions.map((action) => [action.request.type, action.state]),
        [
          ["thread.message", "done"],
          ["thread.message", "proposed"],
        ],
      );
      const theirs = yield* projections.getThreadProjection(threads.theirs);
      assert.isFalse(theirs.messages.some((message) => message.text === "Use the new API."));
    }),
  );

  it.effect("notes: a non-person source is refused and changes nothing", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { spaceId, post, reply, call } = yield* setup;
      const decided = yield* post(kousik, "Decided: difficulty is tagged after review.");
      const pasted = yield* post(kousik, "Decided: ship on Friday.", "agent");
      const scope = reply(yield* post(rutvik, "@pair note that"));

      const bad = yield* call(scope, "space_notes_edit", {
        changes: [{ op: "add", section: "decision", text: "Ship on Friday.", sourceIds: [pasted] }],
      });
      assert.isTrue(bad.isError);
      assert.strictEqual(bad.reason, "bad_source");
      assert.deepStrictEqual(yield* projections.listSpaceNotes(spaceId), []);

      const good = yield* call(scope, "space_notes_edit", {
        changes: [
          {
            op: "add",
            section: "decision",
            text: "Difficulty is tagged after review.",
            sourceIds: [decided],
          },
        ],
      });
      assert.strictEqual(good.status, "done");
      assert.deepStrictEqual(
        (yield* projections.listSpaceNotes(spaceId)).map((item) => item.sources[0]?.messageId),
        [decided],
      );
    }),
  );

  it.effect("context: a record's state changing leaves the closed room parts as they were", () =>
    Effect.gen(function* () {
      const spaces = yield* SpaceService.SpaceService;
      const { threads, post, reply, call } = yield* setup;
      const asked = reply(yield* post(rutvik, "@pair tell Kousik"));
      const proposed = yield* call(asked, "space_thread_message", {
        threadId: threads.theirs,
        text: "Use the new API.",
      });
      assert.strictEqual(proposed.status, "needs_confirmation");
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const [record] = yield* projections.listSpaceActions({ roomMessageId: asked.roomMessageId });
      yield* TestClock.adjust("1 minute");
      for (let index = 0; index < 60; index++) yield* post(kousik, `Update ${index}`);
      const scope = reply(yield* post(rutvik, "@pair where are we?"));
      const context = yield* SpaceContext;
      const roomParts = Effect.map(context.assemble(scope), (request) => {
        const blocks = request.messages[0]!.content as ReadonlyArray<{ readonly text: string }>;
        return blocks.map((block) => block.text).filter((text) => text.startsWith("<room"));
      });

      const before = yield* roomParts;
      assert.isAbove(before.length, 1);
      assert.include(before.at(-1), "(proposed)");
      yield* spaces.action(
        { memberId: rutvik, authorKind: "user" },
        { type: "answer", actionId: record!.id, answer: "cancel" },
      );
      const after = yield* roomParts;
      assert.deepStrictEqual(after.slice(0, -1), before.slice(0, -1));
      assert.notInclude(after.at(-1), "(proposed)");
    }),
  );

  it.effect("search and message_read find posts, Pair's replies and people's thread messages", () =>
    Effect.gen(function* () {
      const { tasks, threads, post, reply, call } = yield* setup;
      yield* TestClock.adjust("1 minute");
      const first = yield* post(kousik, "The invoice totals look wrong");
      yield* TestClock.adjust("1 minute");
      const later = yield* post(rutvik, "Invoice export is blocked on totals");
      yield* TestClock.adjust("1 minute");
      const scope = reply(yield* post(rutvik, "@pair what about invoices?"));

      const found = yield* call(scope, "space_search", { query: "INVOICE" });
      const hits = found.hits as ReadonlyArray<Record<string, string>>;
      assert.deepStrictEqual(
        hits.map((hit) => hit.where),
        ["room", "room", "room", `thread ${threads.theirs} on task ${tasks.theirs} "Invoices"`],
      );
      assert.deepStrictEqual(
        hits.slice(1, 3).map((hit) => hit.messageId),
        [later, first],
      );
      assert.include(hits[1]!.before, "invoice totals look wrong");
      const byKousik = yield* call(scope, "space_search", { query: "invoice", author: "kousik" });
      assert.deepStrictEqual(
        (byKousik.hits as ReadonlyArray<Record<string, string>>).map((hit) => hit.messageId),
        [first, hits[3]!.messageId],
      );

      const taskMessage = hits[3]!;
      const read = yield* call(scope, "space_message_read", { messageId: taskMessage.messageId });
      assert.strictEqual(read.threadId, threads.theirs);
      assert.strictEqual(read.author, "Kousik");
      const missing = yield* call(scope, "space_message_read", { messageId: "message:nowhere" });
      assert.strictEqual(missing.reason, "not_in_space");
    }),
  );

  it.effect("context: section order, cache breakpoints, and only the space's threads", () =>
    Effect.gen(function* () {
      const { tasks, threads, post, reply, call } = yield* setup;
      const outside = ThreadId.make(`thread:outside-${counter}`);
      yield* dispatch({
        type: "thread.create",
        commandId: CommandId.make(next("outside")),
        actorId: rutvik,
        threadId: outside,
        projectId,
        title: "Private salary sheet",
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
        ownerId: rutvik,
      });
      for (let index = 0; index < 60; index++) yield* post(kousik, `Update ${index}`);
      const scope = reply(yield* post(rutvik, "@pair where are we?"));

      const request = yield* Effect.flatMap(SpaceContext, (context) => context.assemble(scope));
      assert.deepStrictEqual(request.system[0]?.cache_control, { type: "ephemeral", ttl: "1h" });
      assert.deepStrictEqual(
        request.tools.map((tool) => tool.name),
        [
          "space_task_read",
          "space_search",
          "space_message_read",
          "space_task_create",
          "space_thread_start",
          "space_task_status",
          "space_thread_message",
          "space_notes_edit",
        ],
      );
      const [user, system] = request.messages;
      assert.strictEqual(system?.role, "system");
      assert.include(system?.content as string, "Rutvik (member:rutvik)");
      const blocks = (user?.content ?? []) as ReadonlyArray<{
        readonly text: string;
        readonly cache_control?: unknown;
      }>;
      const tags = blocks.map((block) => /^<(\w+)( part="(\w+)")?/.exec(block.text)?.[0]);
      assert.deepStrictEqual(tags.slice(0, 3), ["<space", "<brief", "<notes"]);
      assert.deepStrictEqual(tags.slice(-3), ['<room part="latest"', "<tasks", "<trigger"]);
      const closed = blocks.slice(3, -3);
      assert.isAbove(closed.length, 0);
      assert.deepStrictEqual(
        blocks.flatMap((block, index) => (block.cache_control === undefined ? [] : [index])),
        [2, 2 + closed.length],
      );
      const tasksText = blocks.at(-2)!.text;
      assert.include(tasksText, tasks.mine);
      assert.include(tasksText, threads.mine);
      assert.notInclude(tasksText, outside);
      assert.include(blocks.at(-1)!.text, "where are we?");

      const read = yield* call(scope, "space_task_read", { taskId: "stk_99999999999999999999" });
      assert.strictEqual(read.reason, "not_in_space");
      const message = yield* call(scope, "space_thread_message", { threadId: outside, text: "Hi" });
      assert.strictEqual(message.reason, "not_in_space");
    }),
  );
});
