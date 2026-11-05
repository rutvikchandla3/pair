import type {
  MemberId,
  OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
  ThreadId,
  ThreadMemberState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as TeamState from "../team/TeamState.ts";
import {
  holderOf,
  isMemberThreadEvent,
  isThreadPayloadEvent,
  type PersonalStateCarrier,
  viewFor,
  viewThreadEvent,
} from "./MemberThreadState.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/** The member a transport reads for. Null (guests, member-less readers) sees the holder's view. */
export interface ThreadViewer {
  readonly memberId: MemberId;
  readonly serverOwnerId: MemberId;
  /** More than one member has not been removed; read per request, as members change. */
  readonly isTeamMode: Effect.Effect<boolean>;
  readonly readMemberStates: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<
    ReadonlyMap<ThreadId, ThreadMemberState>,
    ProjectionStore.ProjectionStoreV2Error
  >;
}

export const makeThreadViewers = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const { ownerId, isTeamMode } = yield* TeamState.TeamState;
  return (memberId: MemberId | undefined): ThreadViewer | null =>
    memberId === undefined
      ? null
      : {
          memberId,
          serverOwnerId: ownerId,
          isTeamMode,
          readMemberStates: (threadIds) =>
            projections.getMemberStatesForThreads(memberId, threadIds),
        };
});

/** The viewer, in team mode only: whose own older settled threads reads count and filter. */
export function olderSettledReaderOf(
  viewer: ThreadViewer | null,
): Effect.Effect<ThreadViewer | null> {
  return viewer === null
    ? Effect.succeed(null)
    : Effect.map(viewer.isTeamMode, (team) => (team ? viewer : null));
}

/** Reads member rows only for threads the viewer does not hold, in one batch. */
export function overlayForViewer<T extends PersonalStateCarrier>(
  viewer: ThreadViewer | null,
  rows: ReadonlyArray<T>,
): Effect.Effect<ReadonlyArray<T>, ProjectionStore.ProjectionStoreV2Error> {
  if (viewer === null) return Effect.succeed(rows);
  const threadIds = rows.flatMap((row) =>
    holderOf(row, viewer.serverOwnerId) === viewer.memberId ? [] : [row.id],
  );
  if (threadIds.length === 0) return Effect.succeed(rows);
  return viewer
    .readMemberStates(threadIds)
    .pipe(
      Effect.map((states) =>
        rows.map((row) =>
          viewFor(row, viewer.memberId, states.get(row.id) ?? null, viewer.serverOwnerId),
        ),
      ),
    );
}

/**
 * One thread subscription's view: overlays its snapshot thread and maps each event with
 * `viewThreadEvent`, before any coalescing. Member state is read at most once, and only once the
 * viewer turns out not to hold the thread; later member events carry the full state.
 */
export function makeThreadEventView(viewer: ThreadViewer | null, threadId: ThreadId) {
  let cache: ThreadMemberState | null | undefined;
  const load = (): Effect.Effect<
    ThreadMemberState | null,
    ProjectionStore.ProjectionStoreV2Error
  > =>
    cache !== undefined || viewer === null
      ? Effect.succeed(cache ?? null)
      : viewer.readMemberStates([threadId]).pipe(
          Effect.map((states) => {
            cache = states.get(threadId) ?? null;
            return cache;
          }),
        );
  return {
    thread: <T extends OrchestrationV2AppThread>(
      thread: T,
    ): Effect.Effect<T, ProjectionStore.ProjectionStoreV2Error> =>
      viewer === null || holderOf(thread, viewer.serverOwnerId) === viewer.memberId
        ? Effect.succeed(thread)
        : load().pipe(
            Effect.map((state) => viewFor(thread, viewer.memberId, state, viewer.serverOwnerId)),
          ),
    event: (
      event: OrchestrationV2DomainEvent,
    ): Effect.Effect<OrchestrationV2DomainEvent | null, ProjectionStore.ProjectionStoreV2Error> => {
      if (viewer === null) return Effect.succeed(isMemberThreadEvent(event) ? null : event);
      const view = (state: ThreadMemberState | null) => {
        const viewed = viewThreadEvent(event, viewer.memberId, viewer.serverOwnerId, state);
        if (viewed.cache !== state) cache = viewed.cache;
        return viewed.event;
      };
      const needsState =
        cache === undefined &&
        isThreadPayloadEvent(event) &&
        !isMemberThreadEvent(event) &&
        holderOf(event.payload, viewer.serverOwnerId) !== viewer.memberId;
      return needsState ? Effect.map(load(), view) : Effect.succeed(view(cache ?? null));
    },
  };
}
