import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MemberId,
  MessageId,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type SpaceMutation,
  SpaceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as SpaceHandlers from "../mcp/toolkits/space/handlers.ts";
import { SpaceToolkit } from "../mcp/toolkits/space/tools.ts";
import * as SpaceService from "./SpaceService.ts";
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

const launched: Array<ThreadLaunch.ThreadLaunchRequest> = [];

const layerDatabase = SqlitePersistence.layerMemory;
const layerCore = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "spaces" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);
const layer = SpaceService.layer.pipe(
  Layer.provideMerge(layerCore),
  Layer.provide(
    Layer.mergeAll(
      IdAllocator.layer,
      NodeCrypto.layer,
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) =>
          Effect.sync(() => {
            launched.push(input);
            return { threadId: input.threadId!, resumed: false } as ThreadLaunch.ThreadLaunchResult;
          }),
      }),
    ),
  ),
);

const rutvik = MemberId.make("member:rutvik");
const kousik = MemberId.make("member:kousik");
const hanad = MemberId.make("member:hanad");
const spaceId = SpaceId.make("spc_0123456789abcdef0123");
const roomThreadId = ThreadId.make("thread:room");
const taskThreadId = ThreadId.make("thread:task");
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
  projectId,
  memberIds: [kousik],
  pairBilling: { type: "team" },
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

/** The refusal reason the Orchestrator put in the error's cause. */
const refusal = <A, E>(effect: Effect.Effect<A, E, Orchestrator.OrchestratorV2>) =>
  Effect.flip(effect).pipe(
    Effect.map((error) => {
      const cause = (error as { readonly cause?: unknown }).cause;
      return String(cause ?? error);
    }),
  );

const pairEffects = (id: CommandId) =>
  Effect.flatMap(EffectOutbox.EffectOutboxV2, (outbox) => outbox.listByCommandId(id)).pipe(
    Effect.map((effects) => effects.filter((e) => e.request.type === "space.pair-reply.request")),
  );

it.layer(layer)("space orchestration", (it) => {
  it.effect("creates the room, posts, queues @pair for people only, and archives", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createSpace;

      const room = yield* projections.getThread(roomThreadId);
      assert.deepStrictEqual(room.space, { kind: "room", spaceId });
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
      const queued = yield* pairEffects(tagged);
      assert.deepStrictEqual(
        queued.map((effect) => [effect.threadId, effect.request]),
        [
          [
            roomThreadId,
            {
              type: "space.pair-reply.request",
              spaceId,
              postId: MessageId.make("message:tag"),
              taggerId: kousik,
            },
          ],
        ],
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
      assert.deepStrictEqual(yield* pairEffects(fromAgent), []);

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

  it.effect("a task waits for its owner, who can hand it back with a room line", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const placement = {
        kind: "task" as const,
        spaceId,
        createdBy: rutvik,
        description: "Fix the preview renderer",
        base: { baseRef: "main" },
      };
      yield* dispatch({
        type: "thread.create",
        commandId: commandId("task"),
        actorId: rutvik,
        threadId: taskThreadId,
        projectId,
        title: "Preview renderer",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
        ownerId: kousik,
        space: placement,
      });
      const task = yield* projections.getThread(taskThreadId);
      assert.strictEqual(task.ownerId, kousik);
      assert.deepStrictEqual(yield* projections.listSpaceTaskThreadIds(spaceId), [taskThreadId]);

      const update = (
        actorId: MemberId,
        change: Extract<OrchestrationV2ServerCommand, { type: "space.task.update" }>["change"],
      ) =>
        dispatch({
          type: "space.task.update",
          commandId: commandId("update"),
          threadId: taskThreadId,
          spaceId,
          actorId,
          change,
        });
      assert.include(yield* refusal(update(kousik, { type: "remind" })), "not-task-creator");
      yield* update(rutvik, { type: "edit", title: "Preview renderer v2" });
      const reassign = (ownerId: MemberId) =>
        dispatch({
          type: "thread.owner.set",
          commandId: commandId("assign"),
          threadId: taskThreadId,
          actorId: rutvik,
          ownerId,
        });
      assert.include(yield* refusal(reassign(hanad)), "not-a-target-member");
      assert.include(
        yield* refusal(update(rutvik, { type: "hand-back", reason: "nope" })),
        "not-task-owner",
      );
      yield* update(kousik, { type: "hand-back", reason: "On leave this week" });

      const handedBack = yield* projections.getThread(taskThreadId);
      assert.strictEqual(handedBack.ownerId, rutvik);
      assert.strictEqual(handedBack.title, "Preview renderer v2");
      assert.strictEqual(
        handedBack.space?.kind === "task" ? handedBack.space.handedBack?.reason : null,
        "On leave this week",
      );
      const lines = (yield* projections.listSpaceRoomEntries({ spaceId, limit: 50 })).flatMap(
        (entry) => (entry.type === "system" ? [entry.line.type] : []),
      );
      assert.deepStrictEqual(lines.slice(-2), ["task-created", "task-handed-back"]);
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

  it.effect("the service: create, views, typed refusals, and a task that waits for its owner", () =>
    Effect.gen(function* () {
      const spaces = yield* SpaceService.SpaceService;
      const as = (memberId: MemberId) => ({ memberId, authorKind: "user" as const });
      const { space } = yield* spaces.mutate(as(rutvik), {
        type: "create",
        name: "Billing",
        brief: "",
        projectId,
        memberIds: [kousik],
        modelSelection,
      });
      assert.isNotNull(space);
      const spaceId = space!.id;
      assert.match(spaceId, /^spc_[0-9a-f]{20}$/);

      const outsider = yield* spaces.get(as(hanad), { spaceId });
      assert.deepStrictEqual(outsider.type === "not_member" ? outsider.requested : null, false);
      const denied = yield* Effect.flip(
        spaces.post(as(hanad), {
          spaceId,
          messageId: MessageId.make("message:svc-denied"),
          text: "hi",
          mentions: [],
        }),
      );
      assert.strictEqual(denied.reason, "not-member");

      const { threadId } = yield* spaces.task(as(rutvik), {
        type: "create",
        spaceId,
        title: "Invoices",
        description: "Export invoices as CSV",
        ownerId: kousik,
        modelSelection,
        base: { baseRef: "main" },
      });
      assert.deepStrictEqual(launched, []);
      const notOwner = yield* Effect.flip(spaces.task(as(rutvik), { type: "start", threadId }));
      assert.strictEqual(notOwner.reason, "not-task-owner");
      yield* spaces.task(as(kousik), { type: "start", threadId });
      assert.deepStrictEqual(
        launched.map((input) => [
          input.threadId,
          input.reuseExistingThread,
          input.workspaceStrategy,
          input.initialMessage?.text,
          input.actorId,
        ]),
        [[threadId, true, { type: "cloud", baseRef: "main" }, "Export invoices as CSV", kousik]],
      );

      const view = yield* spaces.get(as(kousik), { spaceId, limit: 1 });
      assert.strictEqual(view.type, "member");
      if (view.type !== "member") return;
      assert.deepStrictEqual(
        view.tasks.map((task) => task.id),
        [threadId],
      );
      assert.strictEqual(view.entries.length, 1);
      assert.isTrue(view.hasMoreEntries);

      const left = yield* spaces.mutate(as(kousik), { type: "leave", spaceId });
      assert.isNull(left.space);
    }),
  );
  it.effect("t3_space_manage runs the service's mutations as the connected member", () =>
    Effect.gen(function* () {
      const toolkit = yield* SpaceToolkit.pipe(
        Effect.provide(McpToolAccess.HandlersLayer.layer(SpaceHandlers.layer)),
      );
      const manage = (memberId: MemberId, action: SpaceMutation) =>
        toolkit.handle("t3_space_manage", { action }).pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((parts) => parts.at(-1)?.result),
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(McpInvocationContext.McpInvocationContext, {
                environmentId: EnvironmentId.make("environment"),
                requestNamespace: "client:session-1",
                thread: undefined,
                client: {
                  sessionId: "session-1",
                  memberId,
                  label: "Claude Code",
                  access: "full-access",
                },
                issuedAt: 0,
                capabilities: new Set(["orchestration" as const]),
              }),
              Layer.mock(ThreadManagement.ThreadManagementService)({}),
              NodeCrypto.layer,
            ),
          ),
        );
      const created = yield* manage(rutvik, {
        type: "create",
        name: "Agents",
        brief: "",
        projectId,
        memberIds: [kousik],
        modelSelection,
      });
      const spaceId = (created as { space: { spaceId: SpaceId } }).space.spaceId;
      const summary = (name: string) => ({ space: { spaceId, name, archived: false } });
      const rows: ReadonlyArray<readonly [MemberId, SpaceMutation, object]> = [
        [rutvik, { type: "update", spaceId, name: "Agent tools" }, summary("Agent tools")],
        [
          kousik,
          { type: "archive", spaceId },
          {
            code: "invalid_request",
            message: `Space ${spaceId} refused space.archive: not-owner.`,
          },
        ],
        [rutvik, { type: "member.add", spaceId, memberIds: [hanad] }, summary("Agent tools")],
        [hanad, { type: "leave", spaceId }, { space: null }],
      ];
      for (const [memberId, action, expected] of rows) {
        assert.deepInclude(yield* manage(memberId, action), expected, action.type);
      }
    }),
  );
});
