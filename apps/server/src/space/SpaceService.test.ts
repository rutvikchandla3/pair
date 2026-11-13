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
  SPACE_AGENT_DRIVER,
  SPACE_AGENT_INSTANCE_ID,
  type SpaceId,
  type SpaceMutation,
  type SpaceTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as SpaceHandlers from "../mcp/toolkits/space/handlers.ts";
import { SpaceToolkit } from "../mcp/toolkits/space/tools.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SpaceIntake from "./SpaceIntake.ts";
import * as SpaceService from "./SpaceService.ts";
import * as SpaceWorkspaces from "./SpaceWorkspaces.ts";

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

const rutvik = MemberId.make("member:rutvik");
const kousik = MemberId.make("member:kousik");
const hanad = MemberId.make("member:hanad");
const projectId = ProjectId.make("project:spaces");
const as = (memberId: MemberId) => ({ memberId, authorKind: "user" as const });
const base = {};

const launched: Array<ThreadLaunch.ThreadLaunchRequest> = [];
/** A launch titled "Hangs" creates its thread, resolves this, and never finishes. */
const hung = Deferred.makeUnsafe<ThreadId>();

const layerDatabase = SqlitePersistence.layerMemory;
const layerCore = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "space-service" },
    ProviderAdapterRegistry.layerFromAdapters([adapter, pairAdapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);
const layerLaunch = Layer.unwrap(
  Effect.map(Orchestrator.OrchestratorV2, (orchestrator) =>
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) => {
        if (input.title === "No account") {
          return Effect.fail(
            new ThreadManagement.ThreadManagementProviderInstanceDisabledError({
              projectId: input.projectId,
              instanceId: input.modelSelection!.instanceId,
            }),
          );
        }
        const create = orchestrator
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
          .pipe(Effect.orDie);
        const done = {
          threadId: input.threadId!,
          resumed: false,
        } as ThreadLaunch.ThreadLaunchResult;
        return input.title === "Hangs"
          ? create.pipe(
              Effect.andThen(Deferred.succeed(hung, input.threadId!)),
              Effect.andThen(Effect.never),
            )
          : create.pipe(
              Effect.map(() => {
                launched.push(input);
                return done;
              }),
            );
      },
    }),
  ),
).pipe(Layer.provide(layerCore));
const layer = SpaceService.layer.pipe(
  Layer.provideMerge(layerCore),
  Layer.provide(
    Layer.mergeAll(
      IdAllocator.layer,
      NodeCrypto.layer,
      SpaceIntake.layerDirect.pipe(Layer.provide(layerCore)),
      layerLaunch,
      Layer.mock(SpaceWorkspaces.SpaceWorkspaces)({
        resolve: () => Effect.succeed({ projectId, created: false }),
      }),
    ),
  ),
);

const createSpace = (name: string) =>
  Effect.flatMap(SpaceService.SpaceService, (spaces) =>
    spaces.mutate(as(rutvik), {
      type: "create",
      name,
      brief: "",
      repositoryIds: [projectId],
      memberIds: [kousik],
      modelSelection,
    }),
  ).pipe(Effect.map(({ space }) => space!));

const createTask = (spaceId: SpaceId, title: string, ownerId = kousik) =>
  Effect.flatMap(SpaceService.SpaceService, (spaces) =>
    spaces.createTask(as(rutvik), {
      type: "create",
      spaceId,
      title,
      description: `Do ${title}`,
      ownerId,
    }),
  ).pipe(Effect.map(({ task }) => task!));

const start = (spaceId: SpaceId, taskId: SpaceTaskId) =>
  ({ type: "start", spaceId, taskId, projectId, modelSelection, base }) as const;

/** A turn on the thread, so its agent is a live MCP caller. */
const runTurn = (threadId: ThreadId, actorId: MemberId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`turn:${threadId}`),
      threadId,
      actorId,
      messageId: MessageId.make(`turn:${threadId}`),
      text: "Go.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    }),
  );

/** The `t3_*` toolkit as a member's connected client, or as the agent of one of their threads. */
const toolkitAs = (memberId: MemberId, threadId?: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const toolkit = yield* SpaceToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(SpaceHandlers.layer)),
    );
    return (name: "t3_space_manage" | "t3_space_task_status", params: unknown) =>
      toolkit.handle(name, params as never).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((parts) => parts.at(-1)?.result as Record<string, unknown>),
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(McpInvocationContext.McpInvocationContext, {
              environmentId: EnvironmentId.make("environment"),
              requestNamespace: "client:session-1",
              thread:
                threadId === undefined
                  ? undefined
                  : { threadId, providerSessionId: "session", providerInstanceId: instanceId },
              client:
                threadId === undefined
                  ? {
                      sessionId: "session-1",
                      memberId,
                      label: "Claude Code",
                      access: "full-access",
                    }
                  : undefined,
              issuedAt: 0,
              capabilities: new Set(["orchestration" as const]),
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: orchestrator.getThreadShell,
              getThreadProjection: (id) => projections.getThreadProjection(id).pipe(Effect.orDie),
            }),
            NodeCrypto.layer,
          ),
        ),
      );
  });

it.layer(layer)("SpaceService", (it) => {
  it.effect("create, views, typed refusals, and a thread the starter owns", () =>
    Effect.gen(function* () {
      const spaces = yield* SpaceService.SpaceService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const space = yield* createSpace("Billing");
      assert.match(space.id, /^spc_[0-9a-f]{20}$/);

      const outsider = yield* spaces.get(as(hanad), { spaceId: space.id });
      assert.deepStrictEqual(
        outsider.type === "not_member" ? [outsider.requested, outsider.memberCount] : null,
        [false, 2],
      );
      const denied = yield* Effect.flip(
        spaces.post(as(hanad), {
          spaceId: space.id,
          messageId: MessageId.make("message:svc-denied"),
          text: "hi",
          mentions: [],
        }),
      );
      assert.strictEqual(denied.reason, "not-member");
      const notInSpace = yield* Effect.flip(
        spaces.taskGet(as(hanad), {
          spaceId: space.id,
          taskId: "stk_00000000000000000000" as SpaceTaskId,
        }),
      );
      assert.strictEqual(notInSpace.reason, "not-member");

      const task = yield* createTask(space.id, "Invoices");
      assert.match(task.id, /^stk_[0-9a-f]{20}$/);
      assert.strictEqual(task.status, "todo");
      assert.deepStrictEqual(
        launched.filter((input) => input.title === "Invoices"),
        [],
      );

      // Anyone in the space starts their own thread on it; the status doesn't move.
      const started = yield* spaces.startThread(as(rutvik), {
        ...start(space.id, task.id),
        text: "Export invoices as CSV, newest first",
      });
      assert.isTrue(started.started);
      assert.strictEqual(started.task?.status, "todo");
      assert.deepStrictEqual(
        launched
          .filter((input) => input.threadId === started.threadId)
          .map((input) => [input.workspaceStrategy, input.initialMessage?.text, input.ownerId]),
        [[{ type: "cloud" }, "Export invoices as CSV, newest first", rutvik]],
      );
      assert.deepInclude((yield* projections.getThreadShell(started.threadId!))?.space, {
        kind: "task",
        taskId: task.id,
      });
      const outsiderStart = yield* Effect.flip(
        spaces.startThread(as(hanad), start(space.id, task.id)),
      );
      assert.strictEqual(outsiderStart.reason, "not-member");

      const view = yield* spaces.get(as(kousik), { spaceId: space.id, limit: 1 });
      assert.strictEqual(view.type, "member");
      if (view.type !== "member") return;
      assert.deepStrictEqual(
        view.tasks.map((entry) => entry.id),
        [task.id],
      );
      assert.deepStrictEqual(
        view.threads.map((shell) => shell.id),
        [started.threadId],
      );
      assert.strictEqual(view.entries.length, 1);
      assert.isTrue(view.hasMoreEntries);
      const listed = yield* spaces.list(as(kousik));
      assert.deepStrictEqual(
        listed.tasks.map((entry) => entry.id),
        [task.id],
      );

      const left = yield* spaces.mutate(as(kousik), { type: "leave", spaceId: space.id });
      assert.isNull(left.space);
    }),
  );

  it.effect("taskGet returns only the linked threads the caller may open", () =>
    Effect.gen(function* () {
      const spaces = yield* SpaceService.SpaceService;
      const space = yield* createSpace("Reach");
      const task = yield* createTask(space.id, "Two threads");
      const mine = yield* spaces.startThread(as(rutvik), start(space.id, task.id));
      const theirs = yield* spaces.startThread(as(kousik), start(space.id, task.id));

      const all = yield* spaces.taskGet(as(kousik), { spaceId: space.id, taskId: task.id });
      assert.sameMembers(
        all.threads.map((shell) => shell.id),
        [mine.threadId!, theirs.threadId!],
      );
      assert.isTrue(
        all.entries.some(
          (entry) => entry.type === "system" && entry.line.type === "task-thread-added",
        ),
      );
      const own = yield* spaces.taskGet(
        { ...as(kousik), mayOpen: (threadId) => threadId === theirs.threadId },
        { spaceId: space.id, taskId: task.id },
      );
      assert.deepStrictEqual(
        own.threads.map((shell) => shell.id),
        [theirs.threadId],
      );
    }),
  );

  it.effect("no usable account keeps the task and returns started: false", () =>
    Effect.gen(function* () {
      const spaces = yield* SpaceService.SpaceService;
      const space = yield* createSpace("Accounts");
      const created = yield* spaces.createTask(as(rutvik), {
        type: "create",
        spaceId: space.id,
        title: "No account",
        description: "Needs Claude.",
        ownerId: rutvik,
        start: { projectId, modelSelection, base },
      });
      assert.isFalse(created.started);
      assert.strictEqual(created.task?.title, "No account");
      const refused = yield* Effect.flip(
        spaces.startThread(as(rutvik), start(space.id, created.task!.id)),
      );
      assert.strictEqual(refused.reason, "no-account");
    }),
  );

  it.effect("a start interrupted before its link deletes the thread and leaves no line", () =>
    Effect.gen(function* () {
      const spaces = yield* SpaceService.SpaceService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const space = yield* createSpace("Interrupts");
      const task = yield* createTask(space.id, "Hangs", rutvik);

      const fiber = yield* spaces
        .startThread(as(rutvik), start(space.id, task.id))
        .pipe(Effect.forkChild);
      const threadId = yield* Deferred.await(hung);
      assert.isNotNull(yield* projections.getThreadShell(threadId));
      yield* Fiber.interrupt(fiber);

      assert.isNotNull((yield* projections.getThreadShell(threadId))?.deletedAt);
      const { threads, entries } = yield* spaces.taskGet(as(rutvik), {
        spaceId: space.id,
        taskId: task.id,
      });
      assert.deepStrictEqual(threads, []);
      assert.isFalse(
        entries.some((entry) => entry.type === "system" && entry.line.type === "task-thread-added"),
      );
    }),
  );

  it.effect("t3_space_manage runs the service's mutations as the connected member", () =>
    Effect.gen(function* () {
      const manage = (memberId: MemberId, action: SpaceMutation) =>
        Effect.flatMap(toolkitAs(memberId), (call) => call("t3_space_manage", { action }));
      const created = yield* manage(rutvik, {
        type: "create",
        name: "Agents",
        brief: "",
        repositoryIds: [projectId],
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

  it.effect(
    "t3_space_task_status moves the calling thread's task, and only from such a thread",
    () =>
      Effect.gen(function* () {
        const spaces = yield* SpaceService.SpaceService;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const space = yield* createSpace("Status");
        const task = yield* createTask(space.id, "Ship it", rutvik);
        const { threadId } = yield* spaces.startThread(as(rutvik), start(space.id, task.id));

        yield* runTurn(threadId!, rutvik);
        const call = yield* toolkitAs(rutvik, threadId!);
        const moved = yield* call("t3_space_task_status", { status: "in-review" });
        assert.deepStrictEqual(moved, {
          taskId: task.id,
          title: "Ship it",
          from: "todo",
          to: "in-review",
        });
        const line = (yield* spaces.taskGet(as(rutvik), {
          spaceId: space.id,
          taskId: task.id,
        })).entries.find((entry) => entry.type === "system" && entry.line.type === "task-status");
        assert.deepInclude(line?.type === "system" ? line.line : null, {
          to: "in-review",
          by: { type: "agent", threadId: threadId! },
        });

        const loose = ThreadId.make("thread:not-on-a-task");
        yield* Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
          orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("thread:not-on-a-task"),
            actorId: rutvik,
            threadId: loose,
            projectId,
            title: "Loose",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
            ownerId: rutvik,
          } satisfies OrchestrationV2ServerCommand),
        );
        yield* runTurn(loose, rutvik);
        const refused = yield* Effect.flatMap(toolkitAs(rutvik, loose), (looseCall) =>
          looseCall("t3_space_task_status", { status: "done" }),
        );
        assert.deepInclude(refused, { code: "invalid_request" });
        assert.strictEqual((yield* projections.getSpaceTask(task.id))?.status, "in-review");
      }),
  );
});
