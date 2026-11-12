import {
  type EnvironmentId,
  type MemberId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ThreadShell,
  type ServerConfig,
  type SpaceId,
  type SpaceRoomEntry,
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
import { request, subscribe } from "../rpc/client.ts";
import {
  type SpaceOlderEntries,
  type SpaceRoomEvent,
  type SpaceRoomState,
  applySpaceRoomEvent,
  mergeSpaceRoomView,
  prependSpaceEntries,
  spaceSidebarShells,
  spaceTasksIn,
} from "../spaces.ts";
import {
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

function roomStateOf(view: SpaceView): SpaceRoomState {
  return view.type === "member"
    ? {
        type: "member",
        space: view.space,
        entries: view.entries,
        hasMoreEntries: view.hasMoreEntries,
        tasks: view.tasks,
        notes: view.notes,
        actions: view.actions,
      }
    : view;
}

function isRoomEvent(event: { readonly type: string }): event is SpaceRoomEvent {
  return (
    event.type === "space.updated" ||
    event.type === "space.room-entry" ||
    event.type === "space.action.updated" ||
    event.type === "space.notes.changed"
  );
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
          if (item.kind !== "event" || !isRoomEvent(item.event)) return Effect.succeed(null);
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

export function createSpaceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:spaces:list",
    tag: WS_METHODS.spacesList,
  });
  const refreshList = (
    environmentId: EnvironmentId,
    registry: { refresh: (atom: Atom.Atom<unknown>) => void },
  ) => Effect.sync(() => registry.refresh(list({ environmentId, input: undefined })));

  const room = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "environment-data:spaces:room",
    subscribe: (input: { readonly spaceId: SpaceId }) => spaceRoomStream(input.spaceId),
  });

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
    task: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:task",
      tag: WS_METHODS.spacesTask,
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
  /** Every unarchived task in any space here. */
  readonly tasks: ReadonlyArray<OrchestrationV2ThreadShell>;
  /** Rooms with others' activity since the viewer last opened them. */
  readonly unreadRoomIds: ReadonlySet<string>;
  readonly roomsKey: string;
}

const EMPTY_TASKS: ReadonlyArray<OrchestrationV2ThreadShell> = [];
const EMPTY_SIDEBAR_SHELLS: SpaceSidebarShells = {
  tasks: EMPTY_TASKS,
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

  /** The space's tasks from the live shell, keyed `env\u0000spaceId`; held while none changes. */
  const tasksAtom = Atom.family((key: string) => {
    const separator = key.indexOf("\u0000");
    const environmentId = key.slice(0, separator) as EnvironmentId;
    const spaceId = key.slice(separator + 1);
    let previous = EMPTY_TASKS;
    return Atom.make((get) => {
      const next = spaceTasksIn(get(input.environmentThreadsAtom(environmentId)), spaceId);
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
      const sameTasks = sameItems(next.tasks, previous.tasks);
      const sameUnread =
        next.unreadRoomIds.size === previous.unreadRoomIds.size &&
        [...next.unreadRoomIds].every((id) => previous.unreadRoomIds.has(id));
      if (sameTasks && sameUnread && next.roomsKey === previous.roomsKey) return previous;
      previous = {
        tasks: sameTasks ? previous.tasks : next.tasks,
        unreadRoomIds: sameUnread ? previous.unreadRoomIds : next.unreadRoomIds,
        roomsKey: next.roomsKey,
      };
      return previous;
    }).pipe(Atom.withLabel(`${input.label}:space-sidebar-shells:${environmentId}`));
  });

  return { environmentIdsAtom, tasksAtom, sidebarShellsAtom };
}
