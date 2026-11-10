import {
  type MemberId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type SandboxAccessChange,
  type SandboxId,
  type TerminalMetadataStreamEvent,
  ThreadId,
  type ThreadMemberState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";

import * as ThreadAccess from "../team/ThreadAccess.ts";
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
import type { OlderSettledReader } from "./ShellStream.ts";

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
  readonly readFollowedThreadIds: Effect.Effect<
    ReadonlySet<ThreadId>,
    ProjectionStore.ProjectionStoreV2Error
  >;
  /** Cloud-only servers only. Absent, the viewer may open every thread, as before. */
  readonly access?: ViewerAccess;
}

/** Which threads one member may open, from `ThreadAccess`. Every check is a map lookup. */
export interface ViewerAccess {
  readonly allows: (thread: ThreadAccess.ThreadAccessTarget) => boolean;
  readonly allowsSandbox: (sandboxId: SandboxId) => boolean;
  /** After `caughtUp`. A thread the index has never seen is refused. */
  readonly allowsThreadId: (threadId: ThreadId) => boolean;
  /** A cheap pre-filter: refuses only a thread the index knows this member cannot open. */
  readonly mayAllowThreadId: (threadId: ThreadId) => boolean;
  /** The thread's machine as the index last saw it. */
  readonly sandboxOf: (threadId: ThreadId) => SandboxId | undefined;
  /** The change may have given or taken this member's access. */
  readonly affectedBy: (change: SandboxAccessChange) => boolean;
  readonly caughtUp: Effect.Effect<void>;
  readonly assertThread: (
    threadId: ThreadId,
  ) => Effect.Effect<void, ProjectionStore.ProjectionStoreV2Error>;
  readonly subscribeChanges: Effect.Effect<
    PubSub.Subscription<SandboxAccessChange>,
    never,
    Scope.Scope
  >;
}

export function viewerAccessOf(
  access: ThreadAccess.ThreadAccess["Service"],
  memberId: MemberId,
): ViewerAccess | undefined {
  if (!access.enforced) return undefined;
  const allows = (thread: ThreadAccess.ThreadAccessTarget) => access.allowsThread(memberId, thread);
  return {
    allows,
    allowsSandbox: (sandboxId) => access.allowsSandbox(memberId, sandboxId),
    allowsThreadId: (threadId) => {
      const target = access.threadTarget(threadId);
      return target !== undefined && allows(target);
    },
    mayAllowThreadId: (threadId) => {
      const target = access.threadTarget(threadId);
      return target === undefined || allows(target);
    },
    sandboxOf: (threadId) => access.threadTarget(threadId)?.sandboxId,
    affectedBy: (change) =>
      change.audienceChanged ||
      change.added.includes(memberId) ||
      change.removed.includes(memberId),
    caughtUp: access.caughtUp,
    assertThread: (threadId) => access.assertThread(memberId, threadId),
    subscribeChanges: access.subscribeChanges,
  };
}

export const makeThreadViewers = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const { ownerId, isTeamMode } = yield* TeamState.TeamState;
  const access = yield* ThreadAccess.optional;
  return (memberId: MemberId | undefined): ThreadViewer | null => {
    if (memberId === undefined) return null;
    const viewerAccess = access === undefined ? undefined : viewerAccessOf(access, memberId);
    return {
      memberId,
      serverOwnerId: ownerId,
      isTeamMode,
      readMemberStates: (threadIds) => projections.getMemberStatesForThreads(memberId, threadIds),
      readFollowedThreadIds: projections.listFollowedThreadIds(memberId),
      ...(viewerAccess === undefined ? {} : { access: viewerAccess }),
    };
  };
});

/** The rows this viewer may open, once access reflects every commit the rows were read from. */
export function visibleToViewer<T extends ThreadAccess.ThreadAccessTarget>(
  viewer: ThreadViewer | null,
  rows: ReadonlyArray<T>,
): Effect.Effect<ReadonlyArray<T>> {
  const access = viewer?.access;
  if (access === undefined) return Effect.succeed(rows);
  return Effect.map(access.caughtUp, () => rows.filter(access.allows));
}

/** The viewer, in team mode only: whose own older settled threads reads count and filter. */
export function olderSettledReaderOf(
  viewer: ThreadViewer | null,
): Effect.Effect<OlderSettledReader | null, ProjectionStore.ProjectionStoreV2Error> {
  if (viewer === null) return Effect.succeed(null);
  return Effect.flatMap(viewer.isTeamMode, (team) =>
    team
      ? Effect.map(viewer.readFollowedThreadIds, (followedThreadIds) => ({
          memberId: viewer.memberId,
          serverOwnerId: viewer.serverOwnerId,
          followedThreadIds,
        }))
      : Effect.succeed(null),
  );
}

/** Fails as a missing thread does when the viewer may not open it. */
export function assertViewerThread(
  viewer: ThreadViewer | null,
  threadId: ThreadId,
): Effect.Effect<void, ProjectionStore.ProjectionStoreV2Error> {
  return viewer?.access === undefined ? Effect.void : viewer.access.assertThread(threadId);
}

/**
 * Whether one thread's item may go to the viewer. Streams ask as each item is sent, so the item
 * after a revoke is already dropped. A thread the index has never seen is refused.
 */
export function viewerMayOpen(viewer: ThreadViewer | null, threadId: string): boolean {
  const access = viewer?.access;
  return access === undefined || access.allowsThreadId(ThreadId.make(threadId));
}

/** Terminal metadata without the terminals of threads the viewer may not open. */
export function terminalMetadataForViewer(
  viewer: ThreadViewer | null,
  event: TerminalMetadataStreamEvent,
): TerminalMetadataStreamEvent | null {
  if (viewer?.access === undefined) return event;
  switch (event.type) {
    case "snapshot":
      return {
        ...event,
        terminals: event.terminals.filter((terminal) => viewerMayOpen(viewer, terminal.threadId)),
      };
    case "upsert":
      return viewerMayOpen(viewer, event.terminal.threadId) ? event : null;
    case "remove":
      return viewerMayOpen(viewer, event.threadId) ? event : null;
  }
}

/** Titles by thread id, without threads the viewer may not open. */
export function titlesVisibleToViewer(
  viewer: ThreadViewer | null,
  titles: Readonly<Record<ThreadId, string>>,
): Effect.Effect<Readonly<Record<ThreadId, string>>> {
  const access = viewer?.access;
  if (access === undefined) return Effect.succeed(titles);
  return Effect.map(access.caughtUp, () => {
    const visible: Record<ThreadId, string> = {};
    for (const [key, title] of Object.entries(titles)) {
      const threadId = ThreadId.make(key);
      if (access.allowsThreadId(threadId)) visible[threadId] = title;
    }
    return visible;
  });
}

/**
 * Drops rows the viewer may not open, then reads member rows only for threads the viewer does not
 * hold, in one batch.
 */
export function overlayForViewer<T extends PersonalStateCarrier>(
  viewer: ThreadViewer | null,
  rows: ReadonlyArray<T>,
): Effect.Effect<ReadonlyArray<T>, ProjectionStore.ProjectionStoreV2Error> {
  if (viewer === null) return Effect.succeed(rows);
  if (viewer.access !== undefined) {
    return Effect.flatMap(visibleToViewer(viewer, rows), (visible) =>
      overlayVisible(viewer, visible),
    );
  }
  return overlayVisible(viewer, rows);
}

function overlayVisible<T extends PersonalStateCarrier>(
  viewer: ThreadViewer,
  rows: ReadonlyArray<T>,
): Effect.Effect<ReadonlyArray<T>, ProjectionStore.ProjectionStoreV2Error> {
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
      if (
        viewer.access !== undefined &&
        isThreadPayloadEvent(event) &&
        !viewer.access.allows(event.payload)
      ) {
        return Effect.succeed(null);
      }
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
