import {
  CommandId,
  isSpaceActiveMember,
  type MemberId,
  MessageId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type Space,
  type SpaceActionId,
  type SpaceActionInput,
  type SpaceActionResult,
  SpaceError,
  type SpaceGetInput,
  SpaceId,
  type SpaceListResult,
  type SpaceMutation,
  type SpaceMutationResult,
  type SpaceNotesEditInput,
  type SpaceNotesEditResult,
  type SpacePairVia,
  type SpacePostAuthorKind,
  type SpacePostInput,
  type SpacePostResult,
  type SpaceReplyInput,
  SPACE_ROOM_PAGE_LIMIT,
  SPACE_TASK_ENTRY_LIMIT,
  type SpaceStatusActor,
  type SpaceTask,
  type SpaceTaskAction,
  type SpaceTaskGetInput,
  SpaceTaskId,
  type SpaceTaskResult,
  type SpaceTaskStatus,
  type SpaceTaskView,
  type SpaceView,
  type SpaceWorkspacePreview,
  type SpaceWorkspacePreviewInput,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { spaceReplyTrigger } from "./SpaceAgentDecisions.ts";
import { SpaceIntake } from "./SpaceIntake.ts";
import { SpaceWorkspaces } from "./SpaceWorkspaces.ts";

const DEFAULT_ROOM_PAGE = 100;

/** What a caller is: the member, and whether a person or an agent/API token is posting. */
export interface SpaceCaller {
  readonly memberId: MemberId;
  readonly authorKind: SpacePostAuthorKind;
  /** The threads this caller may open; absent, every thread (MCP tokens, `@pair`). */
  readonly mayOpen?: (threadId: ThreadId) => boolean;
}

/** `@pair` acting for the tagger: its record is written in the same commit as the change. */
export interface SpacePairAct {
  readonly via: SpacePairVia;
  readonly actionId: SpaceActionId;
}

type Action<T extends SpaceTaskAction["type"]> = Extract<SpaceTaskAction, { readonly type: T }>;
export type SpaceTaskCreate = Action<"create">;
export type SpaceThreadStartInput = Action<"start">;
export type SpaceTaskUpdate = Action<"edit" | "reassign" | "hand-back" | "remind">;
export interface SpaceTaskStatusInput {
  readonly spaceId: SpaceId;
  readonly taskId: SpaceTaskId;
  readonly status: SpaceTaskStatus;
  readonly by: SpaceStatusActor;
  readonly askedBy: MemberId | null;
  /** Required when `by` is `pair`. */
  readonly via?: SpacePairVia;
}

/**
 * Spaces for WebSocket clients, MCP tools and `@pair`. Every write is one orchestration command;
 * the Orchestrator decides it (`SpaceDecisions`), and its refusal reaches the caller as a
 * `SpaceError`.
 */
export class SpaceService extends Context.Service<
  SpaceService,
  {
    readonly list: (caller: SpaceCaller) => Effect.Effect<SpaceListResult, SpaceError>;
    readonly get: (
      caller: SpaceCaller,
      input: SpaceGetInput,
    ) => Effect.Effect<SpaceView, SpaceError>;
    readonly taskGet: (
      caller: SpaceCaller,
      input: SpaceTaskGetInput,
    ) => Effect.Effect<SpaceTaskView, SpaceError>;
    readonly workspacePreview: (
      caller: SpaceCaller,
      input: SpaceWorkspacePreviewInput,
    ) => Effect.Effect<SpaceWorkspacePreview, SpaceError>;
    readonly mutate: (
      caller: SpaceCaller,
      input: SpaceMutation,
    ) => Effect.Effect<SpaceMutationResult, SpaceError>;
    readonly post: (
      caller: SpaceCaller,
      input: SpacePostInput,
    ) => Effect.Effect<SpacePostResult, SpaceError>;
    readonly task: (
      caller: SpaceCaller,
      input: SpaceTaskAction,
    ) => Effect.Effect<SpaceTaskResult, SpaceError>;
    /** With `start` and no usable account, the task stays and `started` is false. */
    readonly createTask: (
      caller: SpaceCaller,
      input: SpaceTaskCreate,
      pair?: SpacePairAct,
    ) => Effect.Effect<SpaceTaskResult, SpaceError>;
    /** A new thread on the task, the caller's own; `pair` records `@pair`'s `thread.start`. */
    readonly startThread: (
      caller: SpaceCaller,
      input: SpaceThreadStartInput,
      pair?: SpacePairAct,
    ) => Effect.Effect<SpaceTaskResult, SpaceError>;
    readonly setTaskStatus: (
      caller: SpaceCaller,
      input: SpaceTaskStatusInput,
    ) => Effect.Effect<SpaceTaskResult, SpaceError>;
    readonly undoTaskStatus: (
      caller: SpaceCaller,
      input: Omit<Action<"status.undo">, "type">,
    ) => Effect.Effect<SpaceTaskResult, SpaceError>;
    readonly linkThread: (
      caller: SpaceCaller,
      input: Omit<Action<"thread.link">, "type">,
    ) => Effect.Effect<SpaceTaskResult, SpaceError>;
    readonly updateTask: (
      caller: SpaceCaller,
      input: SpaceTaskUpdate,
    ) => Effect.Effect<SpaceTaskResult, SpaceError>;
    /** Confirm or cancel a card, or Undo a record: the tagger, or any member for a created task. */
    readonly action: (
      caller: SpaceCaller,
      input: SpaceActionInput,
    ) => Effect.Effect<SpaceActionResult, SpaceError>;
    readonly notes: (
      caller: SpaceCaller,
      input: SpaceNotesEditInput,
    ) => Effect.Effect<SpaceNotesEditResult, SpaceError>;
    /** Cancel a queued `@pair` reply, Stop a running one, or Retry a failed one. */
    readonly reply: (
      caller: SpaceCaller,
      input: SpaceReplyInput,
    ) => Effect.Effect<Record<string, never>, SpaceError>;
  }
>()("t3/space/SpaceService") {}

const failed = (message: string) => new SpaceError({ reason: "failed", message });

const isSpaceError = Schema.is(SpaceError);
const isDispatchError = Schema.is(Orchestrator.OrchestratorDispatchError);
const isNoAccount = Schema.is(ThreadManagement.ThreadManagementProviderInstanceDisabledError);

const toSpaceError = (error: unknown): SpaceError => {
  if (isSpaceError(error)) return error;
  if (isDispatchError(error) && isSpaceError(error.cause)) return error.cause;
  if (isNoAccount(error)) {
    return new SpaceError({ reason: "no-account", message: "Connect Claude to start a thread." });
  }
  return failed(error instanceof Error ? error.message : String(error));
};

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStoreV2;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const digest = yield* Digest.Digest;
  const intake = yield* SpaceIntake;
  const workspaces = yield* SpaceWorkspaces;

  /** Stable across retries of one command, which the room thread's receipt makes idempotent. */
  const hashOf = (commandId: CommandId) =>
    digest
      .digest(Digest.sha256, new TextEncoder().encode(commandId))
      .pipe(Effect.map((hash) => Hex.encode(hash).slice(0, 20)));
  const spaceIdFor = (commandId: CommandId) =>
    Effect.map(hashOf(commandId), (hex) => SpaceId.make(`spc_${hex}`));
  const taskIdFor = (commandId: CommandId) =>
    Effect.map(hashOf(commandId), (hex) => SpaceTaskId.make(`stk_${hex}`));

  const commandId = (commandName: string) =>
    ids.allocate.command({ fixtureName: "space", commandName }).pipe(Effect.mapError(toSpaceError));
  const dispatch = (command: OrchestrationV2ServerCommand) =>
    orchestrator.dispatch(command).pipe(Effect.mapError(toSpaceError));
  const read = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(toSpaceError));
  const forbidden = (reason: SpaceError["reason"], message: string) =>
    new SpaceError({ reason, message });
  const creation = (caller: SpaceCaller) =>
    caller.authorKind === "user"
      ? { createdBy: "user" as const, creationSource: "web" as const }
      : { createdBy: "agent" as const, creationSource: "mcp" as const };

  const requireSpace = Effect.fn("SpaceService.requireSpace")(function* (spaceId: SpaceId) {
    const space = yield* read(projections.getSpace(spaceId));
    if (space === null) {
      return yield* new SpaceError({ reason: "not-found", message: `Space ${spaceId} not found.` });
    }
    return space;
  });

  const requireMemberSpace = Effect.fn("SpaceService.requireMemberSpace")(function* (
    caller: SpaceCaller,
    spaceId: SpaceId,
  ) {
    const space = yield* requireSpace(spaceId);
    if (!isSpaceActiveMember(space, caller.memberId)) {
      return yield* forbidden("not-member", `You are not in space ${space.id}.`);
    }
    return space;
  });

  const requireTask = Effect.fn("SpaceService.requireTask")(function* (
    space: Space,
    taskId: SpaceTaskId,
  ) {
    const task = yield* read(projections.getSpaceTask(taskId));
    if (task === null || task.deletedAt !== null || task.spaceId !== space.id) {
      return yield* forbidden("not-found", `Task ${taskId} not found in space ${space.id}.`);
    }
    return task;
  });

  /** The task after a write; null once it is deleted. */
  const taskAfter = (taskId: SpaceTaskId) =>
    read(projections.getSpaceTask(taskId)).pipe(
      Effect.map((task) => (task === null || task.deletedAt !== null ? null : task)),
    );

  const openableShells = Effect.fn("SpaceService.openableShells")(function* (
    caller: SpaceCaller,
    threadIds: ReadonlyArray<ThreadId>,
  ) {
    const allowed = threadIds.filter((id) => caller.mayOpen?.(id) ?? true);
    const shells = yield* Effect.forEach(allowed, (id) => read(projections.getThreadShell(id)), {
      concurrency: 8,
    });
    return shells.filter(
      (shell): shell is OrchestrationV2ThreadShell => shell !== null && shell.deletedAt === null,
    );
  });

  const list: SpaceService["Service"]["list"] = Effect.fn("SpaceService.list")(function* (caller) {
    const spaces = yield* read(projections.listSpaces(caller.memberId));
    const active = spaces.filter(
      (space) => space.archivedAt === null && isSpaceActiveMember(space, caller.memberId),
    );
    return {
      spaces,
      tasks:
        active.length === 0
          ? []
          : yield* read(projections.listOpenSpaceTasks(active.map((space) => space.id))),
    };
  });

  const get: SpaceService["Service"]["get"] = Effect.fn("SpaceService.get")(
    function* (caller, input) {
      const space = yield* requireSpace(input.spaceId);
      if (!isSpaceActiveMember(space, caller.memberId)) {
        return {
          type: "not_member" as const,
          spaceId: space.id,
          name: space.name,
          ownerId: space.ownerId,
          memberCount: space.members.filter((member) => member.removedAt === null).length,
          requested: space.joinRequests.some((r) => r.memberId === caller.memberId),
          archived: space.archivedAt !== null,
        };
      }
      const limit = Math.min(input.limit ?? DEFAULT_ROOM_PAGE, SPACE_ROOM_PAGE_LIMIT);
      const page = yield* read(
        projections.listSpaceRoomEntries({
          spaceId: space.id,
          limit: limit + 1,
          before: input.before,
        }),
      );
      return {
        type: "member" as const,
        space,
        entries: page.length > limit ? page.slice(page.length - limit) : page,
        hasMoreEntries: page.length > limit,
        tasks: yield* read(projections.listSpaceTasks(space.id)),
        threads: yield* openableShells(
          caller,
          yield* read(projections.listSpaceTaskThreadIds(space.id)),
        ),
        notes: yield* read(projections.listSpaceNotes(space.id)),
        actions: yield* read(
          projections.listSpaceActions({ spaceId: space.id, limit: SPACE_ROOM_PAGE_LIMIT }),
        ),
      };
    },
  );

  const taskGet: SpaceService["Service"]["taskGet"] = Effect.fn("SpaceService.taskGet")(
    function* (caller, input) {
      const space = yield* requireMemberSpace(caller, input.spaceId);
      const task = yield* requireTask(space, input.taskId);
      return {
        task,
        threads: yield* openableShells(
          caller,
          yield* read(projections.listSpaceTaskThreadIdsFor(task.id)),
        ),
        entries: yield* read(
          projections.listSpaceTaskEntries({ taskId: task.id, limit: SPACE_TASK_ENTRY_LIMIT }),
        ),
      };
    },
  );

  const workspacePreview: SpaceService["Service"]["workspacePreview"] = Effect.fn(
    "SpaceService.workspacePreview",
  )(function* (caller, input) {
    if (input.spaceId !== undefined) yield* requireMemberSpace(caller, input.spaceId);
    return yield* workspaces.preview(input);
  });

  const mutate: SpaceService["Service"]["mutate"] = Effect.fn("SpaceService.mutate")(
    function* (caller, input) {
      const id = yield* commandId(input.type);
      const actorId = caller.memberId;
      if (input.type === "create") {
        const spaceId = yield* spaceIdFor(id);
        const { projectId } = yield* workspaces.resolve({
          repositoryIds: input.repositoryIds,
          spaceName: input.name,
          workspaceName: input.workspaceName,
          actorId,
        });
        const roomThreadId = yield* ids.allocate
          .thread({ projectId })
          .pipe(Effect.mapError(toSpaceError));
        yield* dispatch({
          type: "space.create",
          commandId: id,
          threadId: roomThreadId,
          spaceId,
          actorId,
          ...creation(caller),
          name: input.name,
          brief: input.brief,
          repositoryIds: input.repositoryIds,
          projectId,
          memberIds: input.memberIds,
          modelSelection: input.modelSelection,
        });
        return { space: yield* requireSpace(spaceId) };
      }
      const space = yield* requireSpace(input.spaceId);
      const base = { commandId: id, threadId: space.roomThreadId, spaceId: space.id, actorId };
      if (input.type === "update") {
        const workspace =
          input.repositoryIds === undefined
            ? undefined
            : yield* workspaces.resolve({
                repositoryIds: input.repositoryIds,
                spaceName: input.name ?? space.name,
                workspaceName: input.workspaceName,
                actorId,
              });
        yield* dispatch({
          ...base,
          type: "space.update",
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.brief === undefined ? {} : { brief: input.brief }),
          ...(workspace === undefined
            ? {}
            : { repositoryIds: input.repositoryIds, projectId: workspace.projectId }),
        });
      } else {
        const { type: _type, spaceId: _spaceId, ...change } = input;
        yield* dispatch({
          ...base,
          ...change,
          type: `space.${input.type}`,
        } as OrchestrationV2ServerCommand);
      }
      const after = yield* requireSpace(space.id);
      return { space: isSpaceActiveMember(after, caller.memberId) ? after : null };
    },
  );

  const post: SpaceService["Service"]["post"] = Effect.fn("SpaceService.post")(
    function* (caller, input) {
      const space = yield* requireSpace(input.spaceId);
      // Keyed by the client's message id, so a retried post is accepted once.
      yield* dispatch({
        type: "space.post",
        commandId: CommandId.make(`space.post:${input.messageId}`),
        threadId: space.roomThreadId,
        spaceId: space.id,
        actorId: caller.memberId,
        messageId: input.messageId,
        text: input.text,
        mentions: input.mentions,
        ...(input.quoteEntryId === undefined ? {} : { quoteEntryId: input.quoteEntryId }),
        authorKind: caller.authorKind,
      });
      const entry = yield* read(projections.getSpaceRoomEntry(input.messageId));
      if (entry === null) return yield* failed(`Post ${input.messageId} was not recorded.`);
      return { entry };
    },
  );

  const updateOn = Effect.fn("SpaceService.updateOn")(function* (
    caller: SpaceCaller,
    space: Space,
    taskId: SpaceTaskId,
    change: Extract<OrchestrationV2ServerCommand, { type: "space.task.update" }>["change"],
    extra: {
      readonly commandId?: CommandId;
      readonly via?: SpacePairVia;
      readonly actionId?: SpaceActionId;
    } = {},
  ) {
    const result = yield* dispatch({
      type: "space.task.update",
      commandId: extra.commandId ?? (yield* commandId(`task.${change.type}`)),
      threadId: space.roomThreadId,
      spaceId: space.id,
      actorId: caller.memberId,
      taskId,
      change,
      ...(extra.via === undefined || extra.actionId === undefined
        ? {}
        : { via: extra.via, spaceActionId: extra.actionId }),
    });
    return { task: yield* taskAfter(taskId), started: false, sequence: result.sequence };
  });

  /**
   * Launch, then link (3.3). The link is the only write that puts a thread on a task, so a start
   * interrupted before it commits deletes the launched thread and leaves no line.
   */
  const startOn = Effect.fn("SpaceService.startOn")(function* (
    caller: SpaceCaller,
    space: Space,
    task: SpaceTask,
    input: SpaceThreadStartInput,
    keys: { readonly key?: string; readonly pair?: SpacePairAct },
  ) {
    const threadId =
      keys.key === undefined
        ? yield* ids.allocate
            .thread({ projectId: input.projectId })
            .pipe(Effect.mapError(toSpaceError))
        : ThreadId.make(`thread:space:${yield* hashOf(CommandId.make(keys.key))}`);
    const launchId =
      keys.key === undefined
        ? yield* commandId("thread.start")
        : CommandId.make(`space.thread.start:${keys.key}`);
    const linkId =
      keys.key === undefined
        ? yield* commandId("thread.link")
        : CommandId.make(`space.thread.link:${keys.key}`);
    let linked = false;
    const launched = yield* Effect.gen(function* () {
      const launched = yield* launches
        .launch({
          commandId: launchId,
          threadId,
          projectId: input.projectId,
          title: task.title,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode ?? "full-access",
          interactionMode: input.interactionMode ?? "default",
          workspaceStrategy: {
            type: "cloud",
            ...(input.base.baseRef === undefined ? {} : { baseRef: input.base.baseRef }),
            ...(input.base.branch === undefined ? {} : { branch: input.base.branch }),
            ...(input.base.existingBranch === true ? { existingBranch: true } : {}),
          },
          initialMessage: { text: input.text ?? task.description, attachments: [] },
          ...creation(caller),
          actorId: caller.memberId,
          ownerId: caller.memberId,
        })
        .pipe(Effect.mapError(toSpaceError));
      yield* Effect.uninterruptible(
        dispatch({
          type: "space.thread.link",
          commandId: linkId,
          threadId,
          actorId: caller.memberId,
          target: { spaceId: space.id, taskId: task.id },
          via: "start",
          ...(keys.pair === undefined
            ? {}
            : { pairVia: keys.pair.via, spaceActionId: keys.pair.actionId }),
        }).pipe(Effect.tap(() => Effect.sync(() => (linked = true)))),
      );
      return launched;
    }).pipe(
      Effect.onInterrupt(() =>
        linked
          ? Effect.void
          : orchestrator
              .dispatch({
                type: "thread.delete",
                commandId: CommandId.make(`${launchId}:cancel`),
                threadId,
                actorId: caller.memberId,
              })
              .pipe(Effect.ignore),
      ),
    );
    return {
      task: yield* taskAfter(task.id),
      threadId,
      started: true,
      ...(launched.sequence === undefined ? {} : { sequence: launched.sequence }),
    };
  });

  const startChecked = Effect.fn("SpaceService.startChecked")(function* (
    caller: SpaceCaller,
    input: SpaceThreadStartInput,
    keys: { readonly key?: string; readonly pair?: SpacePairAct },
  ) {
    const space = yield* requireMemberSpace(caller, input.spaceId);
    if (space.archivedAt !== null) {
      return yield* forbidden("archived", `Space ${space.id} is archived.`);
    }
    const task = yield* requireTask(space, input.taskId);
    return yield* startOn(caller, space, task, input, keys);
  });

  const startThread: SpaceService["Service"]["startThread"] = Effect.fn("SpaceService.startThread")(
    function* (caller, input, pair) {
      return yield* startChecked(
        caller,
        input,
        pair === undefined ? {} : { key: pair.actionId, pair },
      );
    },
  );

  const createTask: SpaceService["Service"]["createTask"] = Effect.fn("SpaceService.createTask")(
    function* (caller, input, pair) {
      const space = yield* requireSpace(input.spaceId);
      const id =
        pair === undefined
          ? yield* commandId("task.create")
          : CommandId.make(`space.task.create:${pair.actionId}`);
      const taskId = yield* taskIdFor(id);
      const created = yield* dispatch({
        type: "space.task.create",
        commandId: id,
        threadId: space.roomThreadId,
        spaceId: space.id,
        actorId: caller.memberId,
        taskId,
        title: input.title,
        description: input.description,
        ownerId: input.ownerId,
        status: input.status ?? "todo",
        ...(pair === undefined ? {} : { via: pair.via, spaceActionId: pair.actionId }),
      });
      const notStarted = {
        task: yield* taskAfter(taskId),
        started: false,
        sequence: created.sequence,
      };
      if (input.start === undefined) return notStarted;
      const started = yield* startChecked(
        caller,
        { type: "start", spaceId: space.id, taskId, ...input.start },
        pair === undefined ? {} : { key: pair.actionId },
      ).pipe(
        Effect.map((result) => ({ result, account: true })),
        Effect.catchIf(
          (error) => error.reason === "no-account",
          () => Effect.succeed({ result: notStarted, account: false }),
        ),
      );
      if (pair !== undefined && started.account) {
        yield* dispatch({
          type: "space.action.started",
          commandId: CommandId.make(`space.action.started:${pair.actionId}`),
          threadId: space.roomThreadId,
          spaceId: space.id,
          actorId: caller.memberId,
          actionId: pair.actionId,
        });
      }
      return started.result;
    },
  );

  const setTaskStatus: SpaceService["Service"]["setTaskStatus"] = Effect.fn(
    "SpaceService.setTaskStatus",
  )(function* (caller, input) {
    const space = yield* requireSpace(input.spaceId);
    const change = {
      type: "status" as const,
      status: input.status,
      by: input.by,
      askedBy: input.askedBy,
    };
    if (input.by.type !== "pair") return yield* updateOn(caller, space, input.taskId, change);
    return yield* updateOn(caller, space, input.taskId, change, {
      commandId: CommandId.make(`space.task.status:${input.by.actionId}`),
      ...(input.via === undefined ? {} : { via: input.via }),
      actionId: input.by.actionId,
    });
  });

  const undoTaskStatus: SpaceService["Service"]["undoTaskStatus"] = Effect.fn(
    "SpaceService.undoTaskStatus",
  )(function* (caller, input) {
    const space = yield* requireSpace(input.spaceId);
    return yield* updateOn(caller, space, input.taskId, {
      type: "status-undo",
      entryId: input.entryId,
    });
  });

  const linkThread: SpaceService["Service"]["linkThread"] = Effect.fn("SpaceService.linkThread")(
    function* (caller, input) {
      const shell = yield* read(projections.getThreadShell(input.threadId));
      if (shell === null || shell.deletedAt !== null) {
        return yield* forbidden("not-found", `Thread ${input.threadId} not found.`);
      }
      const result = yield* dispatch({
        type: "space.thread.link",
        commandId: yield* commandId("thread.link"),
        threadId: input.threadId,
        actorId: caller.memberId,
        target: input.target,
        via: "attach",
      });
      return {
        task: input.target === null ? null : yield* taskAfter(input.target.taskId),
        threadId: input.threadId,
        started: false,
        sequence: result.sequence,
      };
    },
  );

  const updateTask: SpaceService["Service"]["updateTask"] = Effect.fn("SpaceService.updateTask")(
    function* (caller, input) {
      const space = yield* requireSpace(input.spaceId);
      const { spaceId: _spaceId, taskId, ...change } = input;
      return yield* updateOn(caller, space, taskId, change);
    },
  );

  const task: SpaceService["Service"]["task"] = Effect.fn("SpaceService.task")(
    function* (caller, input) {
      switch (input.type) {
        case "create":
          return yield* createTask(caller, input);
        case "start":
          return yield* startThread(caller, input);
        case "status":
          return yield* setTaskStatus(caller, {
            spaceId: input.spaceId,
            taskId: input.taskId,
            status: input.status,
            by: { type: "member", memberId: caller.memberId },
            askedBy: null,
          });
        case "status.undo":
          return yield* undoTaskStatus(caller, input);
        case "thread.link":
          return yield* linkThread(caller, input);
        default:
          return yield* updateTask(caller, input);
      }
    },
  );

  const viaIntake = (command: Parameters<SpaceIntake["Service"]["dispatch"]>[0]) =>
    intake.dispatch(command).pipe(Effect.mapError(toSpaceError));

  const action: SpaceService["Service"]["action"] = Effect.fn("SpaceService.action")(
    function* (caller, input) {
      const record = yield* read(projections.getSpaceAction(input.actionId));
      if (record === null) {
        return yield* forbidden("action-not-found", `Action ${input.actionId} not found.`);
      }
      const space = yield* requireMemberSpace(caller, record.spaceId);
      const anyMember = input.type === "undo" && record.outcome?.type === "task.created";
      if (record.actorId !== caller.memberId && !anyMember) {
        return yield* forbidden("not-tagger", "Only the person who asked @pair can answer this.");
      }
      const base = {
        commandId: yield* commandId(`action.${input.type}`),
        threadId: space.roomThreadId,
        spaceId: space.id,
        actorId: caller.memberId,
        actionId: record.id,
      };
      if (input.type === "answer" && input.answer === "cancel") {
        yield* dispatch({ ...base, type: "space.action.cancel" });
      } else if (input.type === "answer") {
        // Confirm runs exactly the stored input, through the tagger's own guards.
        if (record.request.type !== "thread.message" || record.via === null) {
          return yield* forbidden("action-closed", "This card has nothing to confirm.");
        }
        yield* viaIntake({
          type: "message.dispatch",
          commandId: CommandId.make(`space.action.confirm:${record.id}`),
          threadId: record.request.threadId,
          actorId: caller.memberId,
          messageId: MessageId.make(`pair-message:${record.id}`),
          text: record.request.text,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          via: { pair: record.via },
          spaceActionId: record.id,
          createdBy: "user",
          creationSource: "server",
        });
      } else {
        yield* undoInverse(caller, space, record);
        yield* dispatch({ ...base, type: "space.action.undo" });
      }
      const after = yield* read(projections.getSpaceAction(record.id));
      if (after === null) return yield* failed(`Action ${record.id} was not recorded.`);
      return { action: after };
    },
  );

  /** Undo's inverse command, sent as the person who clicked; notes revert inside the undo. */
  const undoInverse = Effect.fn("SpaceService.undoInverse")(function* (
    caller: SpaceCaller,
    space: Space,
    record: NonNullable<Effect.Success<ReturnType<typeof projections.getSpaceAction>>>,
  ) {
    if (record.state !== "done" || record.outcome === null) return;
    if (record.outcome.type === "task.created") {
      if ((yield* taskAfter(record.outcome.taskId)) === null) return;
      yield* updateOn(
        caller,
        space,
        record.outcome.taskId,
        { type: "delete" },
        { commandId: CommandId.make(`space.action.undo:${record.id}`) },
      );
      return;
    }
    if (record.outcome.type === "thread.message.queued") {
      const messageId = record.outcome.messageId;
      const task = yield* read(projections.getThreadProjection(record.outcome.threadId));
      const run = task.runs.find((candidate) => candidate.userMessageId === messageId);
      if (run?.status === "cancelled") return;
      if (run?.status !== "queued") {
        return yield* forbidden("not-undoable", "The message was already delivered.");
      }
      yield* viaIntake({
        type: "queued-run.cancel",
        commandId: CommandId.make(`space.action.undo:${record.id}`),
        threadId: record.outcome.threadId,
        runId: run.id,
        actorId: caller.memberId,
      });
    }
  });

  const notes: SpaceService["Service"]["notes"] = Effect.fn("SpaceService.notes")(
    function* (caller, input) {
      const space = yield* requireMemberSpace(caller, input.spaceId);
      yield* dispatch({
        type: "space.notes.edit",
        commandId: yield* commandId("notes.edit"),
        threadId: space.roomThreadId,
        spaceId: space.id,
        actorId: caller.memberId,
        changes: input.changes,
        via: null,
      });
      return { notes: yield* read(projections.listSpaceNotes(space.id)) };
    },
  );

  const reply: SpaceService["Service"]["reply"] = Effect.fn("SpaceService.reply")(
    function* (caller, input) {
      const space = yield* requireMemberSpace(caller, input.spaceId);
      const room = yield* read(projections.getThreadProjection(space.roomThreadId));
      const run = room.runs.find((candidate) => candidate.id === input.runId);
      const post =
        run?.userMessageId == null
          ? null
          : yield* read(projections.getSpaceRoomEntry(spaceReplyTrigger(run.userMessageId)));
      if (run === undefined || post?.type !== "post") {
        return yield* forbidden("reply-not-found", `Reply ${input.runId} not found.`);
      }
      if (caller.memberId !== post.authorId && caller.memberId !== space.ownerId) {
        return yield* forbidden("not-tagger", "Only the person who asked, or the owner, can.");
      }
      const base = {
        commandId: yield* commandId(`reply.${input.action}`),
        threadId: space.roomThreadId,
        runId: run.id,
        actorId: caller.memberId,
      };
      switch (input.action) {
        case "cancel":
          yield* dispatch({ ...base, type: "queued-run.cancel" });
          break;
        case "stop":
          yield* dispatch({ ...base, type: "run.interrupt" });
          break;
        case "retry":
          yield* dispatch({ ...base, spaceId: space.id, type: "space.reply.retry" });
          break;
      }
      return {};
    },
  );

  return SpaceService.of({
    list,
    get,
    taskGet,
    workspacePreview,
    mutate,
    post,
    task,
    createTask,
    startThread,
    setTaskStatus,
    undoTaskStatus,
    linkThread,
    updateTask,
    action,
    notes,
    reply,
  });
});

export const layer = Layer.effect(SpaceService, make);
