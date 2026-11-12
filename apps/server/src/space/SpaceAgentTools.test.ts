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
const layerSupport = Layer.mergeAll(
  IdAllocator.layer,
  NodeCrypto.layer,
  SpaceIntake.layerDirect.pipe(Layer.provide(layerCore)),
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
        : Effect.sync(() => {
            launched.push(input);
            return { threadId: input.threadId!, resumed: false } as ThreadLaunch.ThreadLaunchResult;
          }),
  }),
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

const createTask = (
  spaceId: SpaceId,
  threadId: ThreadId,
  ownerId: MemberId,
  title: string,
  started: boolean,
  selection = modelSelection,
) =>
  Effect.gen(function* () {
    yield* dispatch({
      type: "thread.create",
      commandId: CommandId.make(next("task")),
      actorId: ownerId,
      threadId,
      projectId,
      title,
      modelSelection: selection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      ownerId,
      space: {
        kind: "task",
        spaceId,
        createdBy: rutvik,
        description: `Do ${title}`,
        base: { baseRef: "main" },
      },
    });
    if (!started) return;
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

/** A space with Rutvik (owner, tagger) and Kousik, his started task, Kousik's started and unstarted ones. */
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
    projectId: ProjectId.make("project:spaces"),
    memberIds: [kousik],
    pairBilling: { type: "team" },
    modelSelection,
  });
  const tasks = {
    mine: ThreadId.make(`thread:mine-${n}`),
    theirs: ThreadId.make(`thread:theirs-${n}`),
    unstarted: ThreadId.make(`thread:unstarted-${n}`),
  };
  yield* createTask(spaceId, tasks.unstarted, kousik, "Docs", false);
  yield* createTask(spaceId, tasks.mine, rutvik, "Preview renderer", true);
  yield* createTask(spaceId, tasks.theirs, kousik, "Invoices", true);
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
  return { spaceId, roomThreadId, tasks, post, reply, call, n };
});

it.layer(layer)("@pair tools and context", (it) => {
  it.effect("create is idempotent on Retry; a second task in one reply is over_limit", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { spaceId, post, reply, call } = yield* setup;
      const scope = reply(yield* post(rutvik, "@pair make a task for Kousik", "user"));
      const input = { title: "Export CSV", description: "Export invoices as CSV.", owner: kousik };

      const created = yield* call(scope, "space_task_create", input);
      assert.strictEqual(created.status, "done");
      assert.strictEqual(created.started, false);
      const before = yield* projections.listSpaceTaskThreadIds(spaceId);
      const retried = yield* call(
        { ...scope, runId: RunId.make("run:retry") },
        "space_task_create",
        input,
      );
      assert.strictEqual(retried.status, "already_done");
      assert.strictEqual(
        (retried.outcome as { threadId: string }).threadId,
        created.taskId as string,
      );
      assert.deepStrictEqual(yield* projections.listSpaceTaskThreadIds(spaceId), before);

      const second = yield* call(scope, "space_task_create", { ...input, title: "Another" });
      assert.isTrue(second.isError);
      assert.strictEqual(second.reason, "over_limit");
      assert.deepStrictEqual(yield* projections.listSpaceTaskThreadIds(spaceId), before);

      const ownScope = reply(yield* post(rutvik, "@pair one for me"));
      const own = yield* call(ownScope, "space_task_create", {
        title: "Mine",
        description: "Mine.",
      });
      assert.strictEqual(own.started, true);
      assert.strictEqual(launched.at(-1)?.threadId, own.taskId as ThreadId);
      const ownRecord = (yield* projections.listSpaceActions({
        roomMessageId: ownScope.roomMessageId,
      })).at(0);
      assert.deepInclude(ownRecord?.outcome, { type: "task.created", started: true });
    }),
  );

  it.effect("create never borrows another member's account and caps the runtime mode", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const { spaceId, n, post, reply, call } = yield* setup;
      yield* createTask(
        spaceId,
        ThreadId.make(`thread:kousiks-account-${n}`),
        kousik,
        "On my account",
        false,
        kousiksAccount,
      );

      yield* settings.updateSettings({ defaultModelSelection: null });
      const refused = yield* call(
        reply(yield* post(rutvik, "@pair one for me")),
        "space_task_create",
        { title: "Mine", description: "Mine." },
      );
      yield* settings.updateSettings({ defaultModelSelection: modelSelection });
      assert.isTrue(refused.isError);
      assert.strictEqual(refused.reason, "not_allowed");

      const own = yield* call(reply(yield* post(rutvik, "@pair one for me")), "space_task_create", {
        title: "Mine",
        description: "Mine.",
      });
      assert.strictEqual(own.status, "done");
      assert.deepStrictEqual(launched.at(-1)?.modelSelection, modelSelection);
      assert.strictEqual(launched.at(-1)?.runtimeMode, "auto-accept-edits");
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
      });
      assert.strictEqual(created.status, "done");
      assert.strictEqual(created.started, false);
      const record = (yield* projections.listSpaceActions({
        roomMessageId: scope.roomMessageId,
      })).at(0);
      assert.deepInclude(record?.outcome, { type: "task.created", started: false });
    }),
  );

  it.effect("a reply makes at most five writes", () =>
    Effect.gen(function* () {
      const { tasks, post, reply, call } = yield* setup;
      const scope = reply(yield* post(rutvik, "@pair do lots"));
      const created = yield* call(scope, "space_task_create", { title: "One", description: "1." });
      assert.strictEqual(created.status, "done");
      for (const text of ["a", "b", "c", "d"]) {
        const sent = yield* call(scope, "space_task_message", { taskId: tasks.mine, text });
        assert.isFalse(sent.isError);
      }
      const sixth = yield* call(scope, "space_task_message", { taskId: tasks.mine, text: "e" });
      assert.isTrue(sixth.isError);
      assert.strictEqual(sixth.reason, "over_limit");
    }),
  );

  it.effect("messages queue on your task, wait for a confirm on another's, refuse unstarted", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { tasks, post, reply, call } = yield* setup;
      const scope = reply(yield* post(rutvik, "@pair tell them"));

      const queued = yield* call(scope, "space_task_message", {
        taskId: tasks.mine,
        text: "Also handle dark mode.",
      });
      assert.strictEqual(queued.status, "done");
      const again = yield* call(scope, "space_task_message", {
        taskId: tasks.mine,
        text: "Also handle dark mode.",
      });
      assert.strictEqual(again.status, "already_done");
      const mine = yield* projections.getThreadProjection(tasks.mine);
      const sent = mine.messages.filter((message) => message.via !== undefined);
      assert.deepStrictEqual(
        sent.map((message) => [message.text, message.authorId, message.via?.pair.roomMessageId]),
        [["Also handle dark mode.", rutvik, scope.roomMessageId]],
      );
      assert.strictEqual(
        mine.runs.find((run) => run.userMessageId === sent[0]!.id)?.status,
        "queued",
      );

      const proposed = yield* call(scope, "space_task_message", {
        taskId: tasks.theirs,
        text: "Use the new API.",
      });
      assert.strictEqual(proposed.status, "needs_confirmation");
      assert.strictEqual(proposed.ownerName, "Kousik");
      const actions = yield* projections.listSpaceActions({ roomMessageId: scope.roomMessageId });
      assert.deepStrictEqual(
        actions.map((action) => [action.request.type, action.state]),
        [
          ["task.message", "done"],
          ["task.message", "proposed"],
        ],
      );
      const theirs = yield* projections.getThreadProjection(tasks.theirs);
      assert.isFalse(theirs.messages.some((message) => message.text === "Use the new API."));

      const unstarted = yield* call(scope, "space_task_message", {
        taskId: tasks.unstarted,
        text: "Start with the intro.",
      });
      assert.isTrue(unstarted.isError);
      assert.strictEqual(unstarted.reason, "unstarted");
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
      const { tasks, post, reply, call } = yield* setup;
      const asked = reply(yield* post(rutvik, "@pair tell Kousik"));
      const proposed = yield* call(asked, "space_task_message", {
        taskId: tasks.theirs,
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

  it.effect("search and message_read find posts, Pair's replies and people's task messages", () =>
    Effect.gen(function* () {
      const { tasks, post, reply, call } = yield* setup;
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
        ["room", "room", "room", `task ${tasks.theirs} "Invoices"`],
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
      assert.strictEqual(read.threadId, tasks.theirs);
      assert.strictEqual(read.author, "Kousik");
      const missing = yield* call(scope, "space_message_read", { messageId: "message:nowhere" });
      assert.strictEqual(missing.reason, "not_in_space");
    }),
  );

  it.effect("context: section order, cache breakpoints, and only the space's threads", () =>
    Effect.gen(function* () {
      const { tasks, post, reply, call } = yield* setup;
      const outside = ThreadId.make(`thread:outside-${counter}`);
      yield* dispatch({
        type: "thread.create",
        commandId: CommandId.make(next("outside")),
        actorId: rutvik,
        threadId: outside,
        projectId: ProjectId.make("project:spaces"),
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
          "space_task_message",
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
      assert.notInclude(tasksText, outside);
      assert.include(blocks.at(-1)!.text, "where are we?");

      const read = yield* call(scope, "space_task_read", { taskId: outside });
      assert.strictEqual(read.reason, "not_in_space");
    }),
  );
});
