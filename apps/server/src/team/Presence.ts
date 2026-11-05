import {
  type MemberId,
  PRESENCE_FLUSH_MS,
  PRESENCE_TYPING_TTL_MS,
  type PresenceMember,
  type PresenceReportInput,
  type PresenceStatus,
  type PresenceThreadMembers,
  type PresenceUpdate,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/**
 * Who is around, per connection: one socket's RPC client that opened `subscribe`. Kept in memory,
 * never event-sourced. Clients report only while another member is connected, so a member who is
 * alone sends and receives no presence frames.
 */
export class Presence extends Context.Service<
  Presence,
  {
    /** Registers the connection for the scope. Updates never include the caller's own member. */
    readonly subscribe: (connection: {
      readonly connectionId: string;
      readonly memberId: MemberId;
    }) => Effect.Effect<Stream.Stream<PresenceUpdate>, never, Scope.Scope>;
    /** Ignored for a connection that has not subscribed. */
    readonly report: (connectionId: string, input: PresenceReportInput) => Effect.Effect<void>;
  }
>()("t3/team/Presence") {}

interface Connection {
  readonly memberId: MemberId;
  readonly queue: Queue.Queue<PresenceUpdate>;
  idle: boolean;
  viewingThreadId: ThreadId | null;
  /** Always false while `viewingThreadId` is null. */
  typing: boolean;
  // What this connection was last sent, so each update carries only what changed for it.
  sentMembers: ReadonlyArray<PresenceMember>;
  readonly sentViewers: Map<ThreadId, ReadonlyArray<MemberId>>;
  readonly sentTyping: Map<ThreadId, ReadonlyArray<MemberId>>;
}

const sameIds = (left: ReadonlyArray<MemberId>, right: ReadonlyArray<MemberId>) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

const sameMembers = (left: ReadonlyArray<PresenceMember>, right: ReadonlyArray<PresenceMember>) =>
  left.length === right.length &&
  left.every(
    (member, index) =>
      member.memberId === right[index]?.memberId && member.status === right[index]?.status,
  );

const othersIn = (memberIds: ReadonlySet<MemberId> | undefined, self: MemberId) =>
  memberIds === undefined ? [] : [...memberIds].filter((id) => id !== self).toSorted();

/** Remembers `memberIds` as sent and reports whether they differ from what was sent before. */
const markSent = (
  sent: Map<ThreadId, ReadonlyArray<MemberId>>,
  threadId: ThreadId,
  memberIds: ReadonlyArray<MemberId>,
) => {
  if (sameIds(memberIds, sent.get(threadId) ?? [])) return false;
  if (memberIds.length === 0) sent.delete(threadId);
  else sent.set(threadId, memberIds);
  return true;
};

const make = Effect.gen(function* () {
  // Every mutation below runs synchronously, so no other fiber sees a half-applied change.
  const connections = new Map<string, Connection>();
  const typingExpiry = yield* FiberMap.make<string>();
  const flushTimer = yield* FiberHandle.make();
  let flushPending = false;

  const typingIn = (threadId: ThreadId) => {
    const memberIds = new Set<MemberId>();
    for (const connection of connections.values()) {
      if (connection.typing && connection.viewingThreadId === threadId) {
        memberIds.add(connection.memberId);
      }
    }
    return memberIds;
  };

  const sendTyping = (connection: Connection, threadId: ThreadId, typing: Set<MemberId>) => {
    const memberIds = othersIn(typing, connection.memberId);
    if (markSent(connection.sentTyping, threadId, memberIds)) {
      Queue.offerUnsafe(connection.queue, { typing: { threadId, memberIds } });
    }
  };

  // Typing skips the flush: it goes out at once, and only to connections viewing the thread.
  const pushTyping = (threadId: ThreadId) => {
    const typing = typingIn(threadId);
    for (const connection of connections.values()) {
      if (connection.viewingThreadId === threadId) sendTyping(connection, threadId, typing);
    }
  };

  const flushNow = () => {
    flushPending = false;
    const statuses = new Map<MemberId, PresenceStatus>();
    const viewers = new Map<ThreadId, Set<MemberId>>();
    for (const connection of connections.values()) {
      if (!connection.idle) statuses.set(connection.memberId, "online");
      else if (!statuses.has(connection.memberId)) statuses.set(connection.memberId, "away");
      if (connection.viewingThreadId === null) continue;
      const threadViewers = viewers.get(connection.viewingThreadId) ?? new Set();
      viewers.set(connection.viewingThreadId, threadViewers.add(connection.memberId));
    }
    const members = [...statuses]
      .map(([memberId, status]) => ({ memberId, status }))
      .toSorted((left, right) => left.memberId.localeCompare(right.memberId));

    for (const connection of connections.values()) {
      const others = members.filter(({ memberId }) => memberId !== connection.memberId);
      const membersChanged = !sameMembers(others, connection.sentMembers);
      if (membersChanged) connection.sentMembers = others;
      const changedViewers: Array<PresenceThreadMembers> = [];
      for (const threadId of new Set([...viewers.keys(), ...connection.sentViewers.keys()])) {
        const memberIds = othersIn(viewers.get(threadId), connection.memberId);
        if (markSent(connection.sentViewers, threadId, memberIds)) {
          changedViewers.push({ threadId, memberIds });
        }
      }
      if (!membersChanged && changedViewers.length === 0) continue;
      Queue.offerUnsafe(connection.queue, {
        ...(membersChanged ? { members: others } : {}),
        ...(changedViewers.length > 0 ? { viewers: changedViewers } : {}),
      });
    }
  };

  // One trailing-edge flush at most every PRESENCE_FLUSH_MS, and no timer while nothing changes.
  const scheduleFlush = Effect.suspend(() => {
    if (flushPending) return Effect.void;
    flushPending = true;
    return FiberHandle.run(
      flushTimer,
      Effect.sleep(Duration.millis(PRESENCE_FLUSH_MS)).pipe(
        Effect.andThen(Effect.sync(flushNow).pipe(Effect.withSpan("Presence.flush"))),
      ),
    ).pipe(Effect.asVoid);
  });

  // A member alone is never shown to anyone, so reset them before the next arrival can see it.
  const resetIfAlone = (): ReadonlyArray<string> => {
    const memberIds = new Set(Array.from(connections.values(), ({ memberId }) => memberId));
    if (memberIds.size !== 1) return [];
    for (const connection of connections.values()) {
      connection.viewingThreadId = null;
      connection.typing = false;
      connection.idle = false;
    }
    return [...connections.keys()];
  };

  /** The keys whose typing timers should stop, or undefined when another registration owns the key. */
  const removeConnection = (connectionId: string, queue: Queue.Queue<PresenceUpdate>) => {
    const connection = connections.get(connectionId);
    if (connection?.queue !== queue) return undefined;
    connections.delete(connectionId);
    if (connection.typing && connection.viewingThreadId !== null) {
      pushTyping(connection.viewingThreadId);
    }
    return [connectionId, ...resetIfAlone()];
  };

  const stopTyping = (connectionIds: ReadonlyArray<string>) =>
    Effect.forEach(connectionIds, (id) => FiberMap.remove(typingExpiry, id), { discard: true });

  const subscribe = Effect.fn("Presence.subscribe")(function* (input: {
    readonly connectionId: string;
    readonly memberId: MemberId;
  }) {
    const queue = yield* Queue.unbounded<PresenceUpdate>();
    const replaced = connections.get(input.connectionId);
    // A resubscribe from the same client keeps what it reported; the new stream starts empty.
    const connection: Connection = {
      memberId: input.memberId,
      queue,
      idle: replaced?.idle ?? false,
      viewingThreadId: replaced?.viewingThreadId ?? null,
      typing: replaced?.typing ?? false,
      sentMembers: [],
      sentViewers: new Map(),
      sentTyping: new Map(),
    };
    connections.set(input.connectionId, connection);
    if (connection.viewingThreadId !== null) {
      sendTyping(connection, connection.viewingThreadId, typingIn(connection.viewingThreadId));
    }
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const stopped = removeConnection(input.connectionId, queue);
        yield* Queue.shutdown(queue);
        if (stopped === undefined) return;
        yield* stopTyping(stopped);
        yield* scheduleFlush;
      }),
    );
    yield* scheduleFlush;
    return Stream.fromQueue(queue);
  });

  const expireTyping = (connectionId: string, connection: Connection) =>
    Effect.sync(() => {
      if (connections.get(connectionId) !== connection || !connection.typing) return;
      connection.typing = false;
      if (connection.viewingThreadId !== null) pushTyping(connection.viewingThreadId);
    });

  const report = Effect.fn("Presence.report")(function* (
    connectionId: string,
    input: PresenceReportInput,
  ) {
    const connection = connections.get(connectionId);
    if (connection === undefined) return;
    let changed = false;
    let stoppedTyping = false;

    if (
      input.viewingThreadId !== undefined &&
      input.viewingThreadId !== connection.viewingThreadId
    ) {
      const left = connection.viewingThreadId;
      const wasTyping = connection.typing;
      connection.viewingThreadId = input.viewingThreadId;
      connection.typing = false;
      if (wasTyping && left !== null) {
        stoppedTyping = true;
        pushTyping(left);
      }
      if (input.viewingThreadId !== null) {
        sendTyping(connection, input.viewingThreadId, typingIn(input.viewingThreadId));
      }
      changed = true;
    }

    const threadId = connection.viewingThreadId;
    if (input.typing === true && threadId !== null) {
      if (!connection.typing) {
        connection.typing = true;
        pushTyping(threadId);
      }
      stoppedTyping = false;
      yield* FiberMap.run(
        typingExpiry,
        connectionId,
        Effect.sleep(Duration.millis(PRESENCE_TYPING_TTL_MS)).pipe(
          Effect.andThen(expireTyping(connectionId, connection)),
        ),
      );
    } else if (input.typing === false && connection.typing && threadId !== null) {
      connection.typing = false;
      stoppedTyping = true;
      pushTyping(threadId);
    }

    if (input.idle !== undefined && input.idle !== connection.idle) {
      connection.idle = input.idle;
      changed = true;
    }

    if (stoppedTyping) yield* FiberMap.remove(typingExpiry, connectionId);
    if (changed) yield* scheduleFlush;
  });

  return Presence.of({ subscribe, report });
});

export const layer = Layer.effect(Presence, make);
