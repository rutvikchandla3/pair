import {
  type EnvironmentId,
  type MemberId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ThreadShell,
  type ServerConfig,
  type SpaceId,
  type SpaceRoomEntry,
  type SpaceTaskAction,
  type SpaceView,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { request, requestGuarded, subscribe } from "../rpc/client.ts";
import {
  type SpaceOlderEntries,
  type SpaceRoomState,
  applySpaceRoomEvent,
  isSpaceRoomEvent,
  mergeSpaceRoomView,
  prependSpaceEntries,
  spaceSidebarShells,
  spaceTaskThreadsIn,
} from "../spaces.ts";
import {
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
  refreshOnSignalWhileRead,
} from "./runtime.ts";

function roomStateOf(view: SpaceView): SpaceRoomState {
  return view.type === "member"
    ? {
        type: "member",
        space: view.space,
        entries: view.entries,
        hasMoreEntries: view.hasMoreEntries,
        tasks: view.tasks,
        threads: view.threads,
        notes: view.notes,
        actions: view.actions,
      }
    : view;
}

/**
 * The newest page from `spaces.get`, then the room thread's own stream. Each completion marker
 * (first subscribe, reconnect) fetches the page again, which covers anything missed in between.
 */
function spaceRoomStream(spaceId: SpaceId) {
  const get = request(WS_METHODS.spacesGet, { spaceId });
  return Stream.unwrap(
    Effect.gen(function* () {
      const first = roomStateOf(yield* get);
      if (first.type !== "member") return Stream.make(first);
      const state = yield* Ref.make<SpaceRoomState>(first);
      const resync = get.pipe(
        Effect.flatMap((view) =>
          Ref.updateAndGet(state, (current) => mergeSpaceRoomView(current, roomStateOf(view))),
        ),
      );
      const live = subscribe(ORCHESTRATION_V2_WS_METHODS.subscribeThread, {
        threadId: first.space.roomThreadId,
        requestCompletionMarker: true,
      }).pipe(
        Stream.mapEffect((item) => {
          if (item.kind === "synchronized") return resync;
          if (item.kind !== "event" || !isSpaceRoomEvent(item.event)) return Effect.succeed(null);
          const event = item.event;
          return Ref.modify(state, (current) => {
            if (current.type !== "member") return [null, current] as const;
            const next = applySpaceRoomEvent(current, event);
            return [next === current ? null : next, next] as const;
          });
        }),
        Stream.filter(Predicate.isNotNull),
        // Removed from the space: the room stream ends, and the page says Not a member.
        Stream.catchCause((cause) =>
          Predicate.isTagged(Cause.squash(cause), "ThreadAccessRevoked")
            ? Stream.fromEffect(resync)
            : Stream.failCause(cause),
        ),
      );
      return Stream.concat(Stream.make(first), live);
    }),
  );
}

type SpaceTaskInput<T extends SpaceTaskAction["type"]> = Omit<
  Extract<SpaceTaskAction, { readonly type: T }>,
  "type"
>;

/**
 * `shells` comes from `createSpaceShellAtoms`: the list and task pages refetch while read
 * whenever a room's revision moves, which every space and task write does.
 */
export function createSpaceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  shells: Pick<ReturnType<typeof createSpaceShellAtoms>, "roomsKeyAtom" | "roomRevisionAtom">,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:spaces:list",
    tag: WS_METHODS.spacesList,
    refreshTrigger: ({ environmentId }) => shells.roomsKeyAtom(environmentId),
  });

  /** `spaces.taskGet`; keyed `{ spaceId, taskId }`. */
  const taskView = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:spaces:task-get",
    tag: WS_METHODS.spacesTaskGet,
    refreshTrigger: ({ environmentId, input }) =>
      shells.roomRevisionAtom(`${environmentId}\u0000${input.spaceId}`),
  });

  /** Where a space with these repositories would run its threads, for New space and settings. */
  const workspacePreview = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:spaces:workspace-preview",
    tag: WS_METHODS.spacesWorkspacePreview,
  });
  const refreshList = (
    environmentId: EnvironmentId,
    registry: { refresh: (atom: Atom.Atom<unknown>) => void },
  ) => Effect.sync(() => registry.refresh(list({ environmentId, input: undefined })));

  const roomStream = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "environment-data:spaces:room",
    subscribe: (input: { readonly spaceId: SpaceId }) => spaceRoomStream(input.spaceId),
  });
  // A non-member gets one answer and no stream, so a space write here (being added back) asks again.
  const roomFamily = Atom.family((key: string) => {
    const separator = key.indexOf("\u0000");
    const environmentId = key.slice(0, separator) as EnvironmentId;
    const spaceId = key.slice(separator + 1) as SpaceId;
    return roomStream({ environmentId, input: { spaceId } }).pipe(
      refreshOnSignalWhileRead(
        shells.roomsKeyAtom(environmentId),
        (result: AsyncResult.AsyncResult<SpaceRoomState, unknown>) =>
          Option.exists(AsyncResult.value(result), (state) => state.type === "member"),
      ),
    );
  });
  const room = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly spaceId: SpaceId };
  }) => roomFamily(`${target.environmentId}\u0000${target.input.spaceId}`);

  /** Older room pages, prepended to the live page by readers; keyed `env:spaceId`. */
  const olderEntries = Atom.family((_key: string) =>
    Atom.make<SpaceOlderEntries | null>(null).pipe(
      Atom.keepAlive,
      Atom.withLabel(`spaces-older-entries:${_key}`),
    ),
  );

  type LoadOlderInput = { readonly spaceId: SpaceId; readonly before: SpaceRoomEntry["id"] };
  const loadOlder = createEnvironmentCommand(runtime, {
    label: "environment-data:spaces:load-older",
    concurrency: {
      mode: "singleFlight",
      key: (target: { readonly environmentId: EnvironmentId; readonly input: LoadOlderInput }) =>
        `${target.environmentId}:${target.input.spaceId}`,
    },
    execute: (input: LoadOlderInput, registry, environmentId) =>
      request(WS_METHODS.spacesGet, { spaceId: input.spaceId, before: input.before }).pipe(
        Effect.tap((view) =>
          Effect.sync(() => {
            if (view.type !== "member") return;
            const atom = olderEntries(`${environmentId}:${input.spaceId}`);
            const stored = registry.get(atom);
            // Loaded before a fresh live page replaced the one these pages led into: start over.
            const current = stored?.entries[0]?.id === input.before ? stored : null;
            registry.set(atom, {
              entries: prependSpaceEntries(view.entries, current?.entries ?? []),
              hasMore: view.hasMoreEntries,
              anchorId: current?.anchorId ?? input.before,
            });
          }),
        ),
      ),
  });

  return {
    list,
    taskView,
    workspacePreview,
    room,
    olderEntries,
    loadOlder,
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:mutate",
      tag: WS_METHODS.spacesMutate,
      onSuccess: ({ environmentId }, registry) => refreshList(environmentId, registry),
    }),
    post: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:post",
      tag: WS_METHODS.spacesPost,
      // A room's posts reach the server in the order they were sent.
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.spaceId}`,
      },
    }),
    /** Every `spaces.task` action; the commands below are the typed shortcuts the boards use. */
    task: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:task",
      tag: WS_METHODS.spacesTask,
    }),
    startThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:start-thread",
      tag: WS_METHODS.spacesTask,
      execute: (input: SpaceTaskInput<"start">) =>
        requestGuarded(WS_METHODS.spacesTask, { ...input, type: "start" }),
    }),
    setTaskStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:set-task-status",
      tag: WS_METHODS.spacesTask,
      // Quick status keys in a row land in order.
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.taskId}`,
      },
      execute: (input: SpaceTaskInput<"status">) =>
        requestGuarded(WS_METHODS.spacesTask, { ...input, type: "status" }),
    }),
    undoTaskStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:undo-task-status",
      tag: WS_METHODS.spacesTask,
      execute: (input: SpaceTaskInput<"status.undo">) =>
        requestGuarded(WS_METHODS.spacesTask, { ...input, type: "status.undo" }),
    }),
    /** Attach (`target` a task), move (another task) or remove (`target: null`) a thread. */
    linkThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:link-thread",
      tag: WS_METHODS.spacesTask,
      execute: (input: SpaceTaskInput<"thread.link">) =>
        requestGuarded(WS_METHODS.spacesTask, { ...input, type: "thread.link" }),
    }),
  };
}

export type SpaceRoomResult =
  | { readonly type: "loading" }
  | { readonly type: "error"; readonly message: string; readonly reason: string | null }
  | { readonly type: "ready"; readonly room: SpaceRoomState };

export function spaceRoomResultOf(
  result: AsyncResult.AsyncResult<SpaceRoomState, unknown>,
): SpaceRoomResult {
  if (AsyncResult.isSuccess(result)) return { type: "ready", room: result.value };
  if (AsyncResult.isFailure(result)) {
    const error = Cause.squash(result.cause) as {
      readonly reason?: unknown;
      readonly message?: unknown;
    };
    return {
      type: "error",
      message: typeof error?.message === "string" ? error.message : "Could not open the space.",
      reason: typeof error?.reason === "string" ? error.reason : null,
    };
  }
  return { type: "loading" };
}

export interface SpaceSidebarShells {
  /** Every unarchived thread on a task in any space here. */
  readonly taskThreads: ReadonlyArray<OrchestrationV2ThreadShell>;
  /** Rooms with others' activity since the viewer last opened them. */
  readonly unreadRoomIds: ReadonlySet<string>;
  readonly roomsKey: string;
}

const EMPTY_TASKS: ReadonlyArray<OrchestrationV2ThreadShell> = [];
const EMPTY_SIDEBAR_SHELLS: SpaceSidebarShells = {
  taskThreads: EMPTY_TASKS,
  unreadRoomIds: new Set(),
  roomsKey: "",
};

const sameItems = <T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>) =>
  a.length === b.length && a.every((item, index) => item === b[index]);

/** What the clients derive from their own shells: where spaces live, and each space's tasks. */
export function createSpaceShellAtoms(input: {
  readonly label: string;
  readonly connectedEnvironmentIdsAtom: Atom.Atom<ReadonlyArray<EnvironmentId>>;
  readonly serverConfigValueAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerConfig | null>;
  readonly currentMemberIdAtom: (environmentId: EnvironmentId) => Atom.Atom<MemberId | null>;
  readonly environmentThreadsAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ReadonlyArray<OrchestrationV2ThreadShell>>;
}) {
  /** Spaces live on Pair Cloud: connected cloud-only servers where the viewer is a member. */
  const environmentIdsAtom = Atom.make((get): ReadonlyArray<EnvironmentId> => {
    const previous = Option.getOrUndefined(get.self<ReadonlyArray<EnvironmentId>>());
    const next = get(input.connectedEnvironmentIdsAtom).filter(
      (id) =>
        get(input.serverConfigValueAtom(id))?.environment.capabilities.cloudLaunch === true &&
        get(input.currentMemberIdAtom(id)) !== null,
    );
    return previous !== undefined && sameItems(previous, next) ? previous : next;
  }).pipe(Atom.withLabel(`${input.label}:space-environment-ids`));

  /** The space's task threads from the live shell, keyed `env\u0000spaceId`; held while none changes. */
  const taskThreadsAtom = Atom.family((key: string) => {
    const separator = key.indexOf("\u0000");
    const environmentId = key.slice(0, separator) as EnvironmentId;
    const spaceId = key.slice(separator + 1);
    let previous = EMPTY_TASKS;
    return Atom.make((get) => {
      const next = spaceTaskThreadsIn(get(input.environmentThreadsAtom(environmentId)), spaceId);
      if (sameItems(next, previous)) return previous;
      previous = next.length === 0 ? EMPTY_TASKS : next;
      return previous;
    }).pipe(Atom.withLabel(`${input.label}:space-shell-tasks:${key}`));
  });

  /** Held while no task, room or unread flag changes, so streaming turns elsewhere don't redraw it. */
  const sidebarShellsAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous = EMPTY_SIDEBAR_SHELLS;
    return Atom.make((get) => {
      const next = spaceSidebarShells(
        get(input.environmentThreadsAtom(environmentId)),
        get(input.currentMemberIdAtom(environmentId)),
      );
      const sameTasks = sameItems(next.taskThreads, previous.taskThreads);
      const sameUnread =
        next.unreadRoomIds.size === previous.unreadRoomIds.size &&
        [...next.unreadRoomIds].every((id) => previous.unreadRoomIds.has(id));
      if (sameTasks && sameUnread && next.roomsKey === previous.roomsKey) return previous;
      previous = {
        taskThreads: sameTasks ? previous.taskThreads : next.taskThreads,
        unreadRoomIds: sameUnread ? previous.unreadRoomIds : next.unreadRoomIds,
        roomsKey: next.roomsKey,
      };
      return previous;
    }).pipe(Atom.withLabel(`${input.label}:space-sidebar-shells:${environmentId}`));
  });

  /** Changes on every space or task write in any room here; drives `list` refetches. */
  const roomsKeyAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(sidebarShellsAtom(environmentId)).roomsKey).pipe(
      Atom.withLabel(`${input.label}:space-rooms-key:${environmentId}`),
    ),
  );

  /** One room's revision from its shell, keyed `env\u0000spaceId`; drives `taskView` refetches. */
  const roomRevisionAtom = Atom.family((key: string) => {
    const separator = key.indexOf("\u0000");
    const environmentId = key.slice(0, separator) as EnvironmentId;
    const spaceId = key.slice(separator + 1);
    return Atom.make((get) => {
      const room = get(input.environmentThreadsAtom(environmentId)).find(
        (thread) => thread.space?.kind === "room" && thread.space.spaceId === spaceId,
      );
      return room?.space?.kind === "room" ? (room.space.revision ?? null) : null;
    }).pipe(Atom.withLabel(`${input.label}:space-room-revision:${key}`));
  });

  return { environmentIdsAtom, taskThreadsAtom, sidebarShellsAtom, roomsKeyAtom, roomRevisionAtom };
}
