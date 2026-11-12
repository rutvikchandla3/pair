import {
  CommandId,
  isSpaceActiveMember,
  type MemberId,
  type OrchestrationV2ServerCommand,
  type Space,
  SpaceError,
  SpaceId,
  type SpaceListResult,
  type SpaceMutation,
  type SpaceMutationResult,
  type SpacePostAuthorKind,
  type SpacePostInput,
  type SpacePostResult,
  SPACE_ROOM_PAGE_LIMIT,
  type SpaceGetInput,
  type SpaceTaskAction,
  type SpaceTaskResult,
  type SpaceView,
  type ThreadId,
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

const DEFAULT_ROOM_PAGE = 100;

/** What a caller is: the member, and whether a person or an agent/API token is posting. */
export interface SpaceCaller {
  readonly memberId: MemberId;
  readonly authorKind: SpacePostAuthorKind;
}

/**
 * Spaces for WebSocket clients and MCP tools. Every write is one orchestration command; the
 * Orchestrator decides it (`SpaceDecisions`), and its refusal reaches the caller as a `SpaceError`.
 */
export class SpaceService extends Context.Service<
  SpaceService,
  {
    readonly list: (caller: SpaceCaller) => Effect.Effect<SpaceListResult, SpaceError>;
    readonly get: (
      caller: SpaceCaller,
      input: SpaceGetInput,
    ) => Effect.Effect<SpaceView, SpaceError>;
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
  }
>()("t3/space/SpaceService") {}

const failed = (message: string) => new SpaceError({ reason: "failed", message });

const isSpaceError = Schema.is(SpaceError);
const isDispatchError = Schema.is(Orchestrator.OrchestratorDispatchError);

const toSpaceError = (error: unknown): SpaceError => {
  if (isSpaceError(error)) return error;
  if (isDispatchError(error) && isSpaceError(error.cause)) return error.cause;
  return failed(error instanceof Error ? error.message : String(error));
};

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStoreV2;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const digest = yield* Digest.Digest;

  /** Stable across retries of one command, which the room thread's receipt makes idempotent. */
  const spaceIdFor = (commandId: CommandId) =>
    digest
      .digest(Digest.sha256, new TextEncoder().encode(commandId))
      .pipe(Effect.map((hash) => SpaceId.make(`spc_${Hex.encode(hash).slice(0, 20)}`)));

  const commandId = (commandName: string) =>
    ids.allocate.command({ fixtureName: "space", commandName }).pipe(Effect.mapError(toSpaceError));
  const dispatch = (command: OrchestrationV2ServerCommand) =>
    orchestrator.dispatch(command).pipe(Effect.mapError(toSpaceError));
  const read = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(toSpaceError));

  const requireSpace = Effect.fn("SpaceService.requireSpace")(function* (spaceId: SpaceId) {
    const space = yield* read(projections.getSpace(spaceId));
    if (space === null) {
      return yield* new SpaceError({ reason: "not-found", message: `Space ${spaceId} not found.` });
    }
    return space;
  });

  const requireTask = Effect.fn("SpaceService.requireTask")(function* (threadId: ThreadId) {
    const shell = yield* read(projections.getThreadShell(threadId));
    if (shell?.space?.kind !== "task") {
      return yield* new SpaceError({
        reason: "not-a-task",
        message: `Thread ${threadId} is not a space task.`,
      });
    }
    return { shell, placement: shell.space };
  });

  const visible = (space: Space, caller: SpaceCaller) =>
    isSpaceActiveMember(space, caller.memberId) ? space : null;

  const list: SpaceService["Service"]["list"] = Effect.fn("SpaceService.list")(function* (caller) {
    return { spaces: yield* read(projections.listSpaces(caller.memberId)) };
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
      const taskIds = yield* read(projections.listSpaceTaskThreadIds(space.id));
      const shells = yield* Effect.forEach(taskIds, (id) => read(projections.getThreadShell(id)), {
        concurrency: 8,
      });
      return {
        type: "member" as const,
        space,
        entries: page.length > limit ? page.slice(page.length - limit) : page,
        hasMoreEntries: page.length > limit,
        tasks: shells.flatMap((shell) =>
          shell === null || shell.deletedAt !== null ? [] : [shell],
        ),
      };
    },
  );

  const mutate: SpaceService["Service"]["mutate"] = Effect.fn("SpaceService.mutate")(
    function* (caller, input) {
      const id = yield* commandId(input.type);
      const actorId = caller.memberId;
      if (input.type === "create") {
        const spaceId = yield* spaceIdFor(id);
        const roomThreadId = yield* ids.allocate
          .thread({ projectId: input.projectId })
          .pipe(Effect.mapError(toSpaceError));
        yield* dispatch({
          type: "space.create",
          commandId: id,
          threadId: roomThreadId,
          spaceId,
          actorId,
          createdBy: caller.authorKind === "user" ? "user" : "agent",
          creationSource: caller.authorKind === "user" ? "web" : "mcp",
          name: input.name,
          brief: input.brief,
          projectId: input.projectId,
          memberIds: input.memberIds,
          pairBilling: input.pairBilling ?? { type: "team" },
          modelSelection: input.modelSelection,
        });
        return { space: yield* requireSpace(spaceId) };
      }
      const space = yield* requireSpace(input.spaceId);
      const base = { commandId: id, threadId: space.roomThreadId, spaceId: space.id, actorId };
      const { type: _type, spaceId: _spaceId, ...change } = input;
      yield* dispatch({
        ...base,
        ...change,
        type: `space.${input.type}`,
      } as OrchestrationV2ServerCommand);
      return { space: visible(yield* requireSpace(space.id), caller) };
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

  const startTask = Effect.fn("SpaceService.startTask")(function* (
    caller: SpaceCaller,
    threadId: ThreadId,
    modelSelection: Extract<SpaceTaskAction, { type: "start" }>["modelSelection"],
    text?: string,
  ) {
    const { shell, placement } = yield* requireTask(threadId);
    const space = yield* requireSpace(placement.spaceId);
    if (shell.ownerId !== caller.memberId) {
      return yield* new SpaceError({
        reason: "not-task-owner",
        message: "Only the task's owner can start it.",
      });
    }
    if (space.archivedAt !== null) {
      return yield* new SpaceError({
        reason: "archived",
        message: `Space ${space.id} is archived.`,
      });
    }
    if (shell.latestRunId !== null) return { threadId, started: true };
    const selection = modelSelection ?? shell.modelSelection;
    if (modelSelection !== undefined) {
      yield* dispatch({
        type: "thread.model-selection.set",
        commandId: yield* commandId("task.model"),
        threadId,
        actorId: caller.memberId,
        modelSelection,
      });
    }
    const launched = yield* launches
      .launch({
        commandId: yield* commandId("task.start"),
        threadId,
        reuseExistingThread: true,
        projectId: shell.projectId,
        title: shell.title,
        modelSelection: selection,
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        workspaceStrategy: {
          type: "cloud",
          baseRef: placement.base.baseRef,
          ...(placement.base.branch === undefined ? {} : { branch: placement.base.branch }),
          ...(placement.base.existingBranch === true ? { existingBranch: true } : {}),
        },
        initialMessage: { text: text ?? placement.description, attachments: [] },
        createdBy: caller.authorKind === "user" ? "user" : "agent",
        creationSource: caller.authorKind === "user" ? "web" : "mcp",
        actorId: caller.memberId,
      })
      .pipe(Effect.mapError(toSpaceError));
    return {
      threadId,
      started: true,
      ...(launched.sequence === undefined ? {} : { sequence: launched.sequence }),
    };
  });

  const task: SpaceService["Service"]["task"] = Effect.fn("SpaceService.task")(
    function* (caller, input) {
      const actorId = caller.memberId;
      switch (input.type) {
        case "create": {
          const space = yield* requireSpace(input.spaceId);
          const threadId = yield* ids.allocate
            .thread({ projectId: space.projectId })
            .pipe(Effect.mapError(toSpaceError));
          const result = yield* dispatch({
            type: "thread.create",
            commandId: yield* commandId("task.create"),
            threadId,
            projectId: space.projectId,
            title: input.title,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode ?? "full-access",
            interactionMode: input.interactionMode ?? "default",
            branch: null,
            worktreePath: null,
            createdBy: caller.authorKind === "user" ? "user" : "agent",
            creationSource: caller.authorKind === "user" ? "web" : "mcp",
            actorId,
            ownerId: input.ownerId,
            space: {
              kind: "task",
              spaceId: space.id,
              createdBy: actorId,
              description: input.description,
              base: input.base,
            },
          });
          if (input.ownerId === actorId) return yield* startTask(caller, threadId, undefined);
          return { threadId, started: false, sequence: result.sequence };
        }
        case "start":
          return yield* startTask(caller, input.threadId, input.modelSelection, input.text);
        case "reassign": {
          const { shell, placement } = yield* requireTask(input.threadId);
          if (actorId !== placement.createdBy && actorId !== shell.ownerId) {
            return yield* new SpaceError({
              reason: "not-task-creator",
              message: "Only the task's creator or owner can reassign it.",
            });
          }
          if (shell.latestRunId !== null) {
            return yield* new SpaceError({
              reason: "task-started",
              message: "A started task stays with its owner.",
            });
          }
          const result = yield* dispatch({
            type: "thread.owner.set",
            commandId: yield* commandId("task.reassign"),
            threadId: input.threadId,
            ownerId: input.ownerId,
            actorId,
          });
          return { threadId: input.threadId, started: false, sequence: result.sequence };
        }
        default: {
          const { placement, shell } = yield* requireTask(input.threadId);
          const { type, threadId, ...rest } = input;
          const result = yield* dispatch({
            type: "space.task.update",
            commandId: yield* commandId(`task.${type}`),
            threadId,
            spaceId: placement.spaceId,
            actorId,
            change: { type, ...rest } as Extract<
              OrchestrationV2ServerCommand,
              { type: "space.task.update" }
            >["change"],
          });
          return {
            threadId,
            started: shell.latestRunId !== null,
            sequence: result.sequence,
          };
        }
      }
    },
  );

  return SpaceService.of({ list, get, mutate, post, task });
});

export const layer = Layer.effect(SpaceService, make);
