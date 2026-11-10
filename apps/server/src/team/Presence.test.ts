import { MemberId, type PresenceReportInput, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Presence from "./Presence.ts";

const alice = MemberId.make("alice");
const bob = MemberId.make("bob");
const carol = MemberId.make("carol");
const threadX = ThreadId.make("thread-x");
const threadY = ThreadId.make("thread-y");
const threadZ = ThreadId.make("thread-z");

const connect = Effect.fnUntraced(function* (
  connectionId: string,
  memberId: MemberId,
  mayOpen?: (threadId: ThreadId) => boolean,
) {
  const presence = yield* Presence.Presence;
  const scope = yield* Scope.fork(yield* Effect.scope);
  const updates = yield* presence
    .subscribe({ connectionId, memberId, ...(mayOpen === undefined ? {} : { mayOpen }) })
    .pipe(Effect.flatMap(Stream.toQueue({ capacity: "unbounded" })), Scope.provide(scope));
  return {
    updates,
    report: (input: PresenceReportInput) => presence.report(connectionId, input),
    close: Scope.close(scope, Exit.void),
  };
});

type Connection = Effect.Success<ReturnType<typeof connect>>;

/** Lets the clock run, then reads how many updates each connection holds. */
const sizesAfter = (millis: number, ...connections: ReadonlyArray<Connection>) =>
  TestClock.adjust(millis).pipe(
    Effect.andThen(Effect.forEach(connections, ({ updates }) => Queue.size(updates))),
  );

const drain = (...connections: ReadonlyArray<Connection>) =>
  Effect.forEach(connections, ({ updates }) => Queue.clear(updates), { discard: true });

const online = (memberId: MemberId) => ({ memberId, status: "online" });

describe("Presence", () => {
  it.effect("sends nothing while a member is alone, across their tabs", () =>
    Effect.gen(function* () {
      const first = yield* connect("a-1", alice);
      const second = yield* connect("a-2", alice);
      yield* first.report({ viewingThreadId: threadX, typing: true });
      yield* second.report({ viewingThreadId: threadX, idle: true });

      expect(yield* sizesAfter(5_000, first, second)).toEqual([0, 0]);
    }).pipe(Effect.scoped, Effect.provide(Presence.layer)),
  );

  it.effect("tells each member about the other one flush after they join", () =>
    Effect.gen(function* () {
      const a = yield* connect("a", alice);
      const b = yield* connect("b", bob);

      expect(yield* sizesAfter(999, a, b)).toEqual([0, 0]);
      yield* TestClock.adjust(1);
      expect(yield* Queue.take(a.updates)).toEqual({ members: [online(bob)] });
      expect(yield* Queue.take(b.updates)).toEqual({ members: [online(alice)] });
    }).pipe(Effect.scoped, Effect.provide(Presence.layer)),
  );

  it.effect("coalesces viewer changes into one update with only the final thread", () =>
    Effect.gen(function* () {
      const a = yield* connect("a", alice);
      const b = yield* connect("b", bob);
      yield* TestClock.adjust(1_000);
      yield* drain(a, b);

      for (const threadId of [threadX, threadY, threadX, threadZ]) {
        yield* b.report({ viewingThreadId: threadId });
      }
      yield* TestClock.adjust(1_000);
      expect(yield* Queue.take(a.updates)).toEqual({
        viewers: [{ threadId: threadZ, memberIds: [bob] }],
      });
      expect(yield* sizesAfter(5_000, a, b)).toEqual([0, 0]);
    }).pipe(Effect.scoped, Effect.provide(Presence.layer)),
  );

  it.effect("sends typing at once, only to the thread's viewers, until it expires or stops", () =>
    Effect.gen(function* () {
      const a = yield* connect("a", alice);
      const b = yield* connect("b", bob);
      const c = yield* connect("c", carol);
      yield* a.report({ viewingThreadId: threadX });
      yield* b.report({ viewingThreadId: threadX });
      yield* c.report({ viewingThreadId: threadY });
      yield* TestClock.adjust(1_000);
      yield* drain(a, b, c);
      const bobTyping = { typing: { threadId: threadX, memberIds: [bob] } };
      const nobodyTyping = { typing: { threadId: threadX, memberIds: [] } };

      yield* b.report({ typing: true });
      expect(yield* Queue.take(a.updates)).toEqual(bobTyping);
      expect(yield* sizesAfter(5_000, a, b, c)).toEqual([0, 0, 0]);
      yield* b.report({ typing: true });
      expect(yield* sizesAfter(7_999, a, b, c)).toEqual([0, 0, 0]);
      yield* TestClock.adjust(1);
      expect(yield* Queue.take(a.updates)).toEqual(nobodyTyping);

      yield* b.report({ typing: true });
      expect(yield* Queue.take(a.updates)).toEqual(bobTyping);
      yield* b.report({ typing: false });
      expect(yield* Queue.take(a.updates)).toEqual(nobodyTyping);

      yield* b.report({ typing: true });
      expect(yield* Queue.take(a.updates)).toEqual(bobTyping);
      yield* b.report({ viewingThreadId: threadY });
      expect(yield* Queue.take(a.updates)).toEqual(nobodyTyping);
      expect(yield* sizesAfter(0, b, c)).toEqual([0, 0]);
    }).pipe(Effect.scoped, Effect.provide(Presence.layer)),
  );

  it.effect("tells who views or types in a thread only to a member who can open it", () =>
    Effect.gen(function* () {
      const a = yield* connect("a", alice);
      const c = yield* connect("c", carol, (threadId) => threadId !== threadX);
      yield* a.report({ viewingThreadId: threadX });
      yield* c.report({ viewingThreadId: threadX });
      yield* TestClock.adjust(1_000);
      expect(yield* Queue.take(c.updates)).toEqual({ members: [online(alice)] });
      expect(yield* Queue.take(a.updates)).toEqual({
        members: [online(carol)],
        viewers: [{ threadId: threadX, memberIds: [carol] }],
      });

      yield* a.report({ typing: true });
      yield* a.report({ viewingThreadId: threadY });
      yield* TestClock.adjust(1_000);
      expect(yield* Queue.take(c.updates)).toEqual({
        viewers: [{ threadId: threadY, memberIds: [alice] }],
      });
      expect(yield* sizesAfter(0, c)).toEqual([0]);
    }).pipe(Effect.scoped, Effect.provide(Presence.layer)),
  );

  it.effect("shows a member once across tabs and drops them when the last tab closes", () =>
    Effect.gen(function* () {
      const a = yield* connect("a", alice);
      const firstTab = yield* connect("b-1", bob);
      const secondTab = yield* connect("b-2", bob);
      yield* firstTab.report({ viewingThreadId: threadX });
      yield* secondTab.report({ viewingThreadId: threadX });
      yield* TestClock.adjust(1_000);
      expect(yield* Queue.take(a.updates)).toEqual({
        members: [online(bob)],
        viewers: [{ threadId: threadX, memberIds: [bob] }],
      });

      yield* firstTab.close;
      expect(yield* sizesAfter(1_000, a)).toEqual([0]);
      yield* secondTab.close;
      yield* TestClock.adjust(1_000);
      expect(yield* Queue.take(a.updates)).toEqual({
        members: [],
        viewers: [{ threadId: threadX, memberIds: [] }],
      });
    }).pipe(Effect.scoped, Effect.provide(Presence.layer)),
  );

  it.effect("resets a member left alone, so a returning member never sees stale state", () =>
    Effect.gen(function* () {
      const a = yield* connect("a-1", alice);
      const b = yield* connect("b", bob);
      yield* b.report({ viewingThreadId: threadX, typing: true, idle: true });
      yield* TestClock.adjust(1_000);
      yield* drain(a, b);

      yield* a.close;
      yield* TestClock.adjust(1_000);
      expect(yield* Queue.take(b.updates)).toEqual({ members: [] });
      // Bob's client reports nothing while he is alone, so his server state stays at the reset.
      const returned = yield* connect("a-2", alice);
      yield* TestClock.adjust(1_000);
      expect(yield* Queue.take(returned.updates)).toEqual({ members: [online(bob)] });
      expect(yield* sizesAfter(8_000, returned)).toEqual([0]);
    }).pipe(Effect.scoped, Effect.provide(Presence.layer)),
  );

  it.effect("marks a member away only when every tab is idle", () =>
    Effect.gen(function* () {
      const a = yield* connect("a", alice);
      const firstTab = yield* connect("b-1", bob);
      yield* TestClock.adjust(1_000);
      yield* drain(a, firstTab);

      yield* firstTab.report({ idle: true });
      yield* TestClock.adjust(1_000);
      expect(yield* Queue.take(a.updates)).toEqual({
        members: [{ memberId: bob, status: "away" }],
      });

      yield* connect("b-2", bob);
      yield* TestClock.adjust(1_000);
      expect(yield* Queue.take(a.updates)).toEqual({ members: [online(bob)] });
    }).pipe(Effect.scoped, Effect.provide(Presence.layer)),
  );

  it.effect("keeps a resubscribe on the same key when the old stream closes", () =>
    Effect.gen(function* () {
      const a = yield* connect("a", alice);
      const before = yield* connect("b", bob);
      yield* before.report({ viewingThreadId: threadX });
      yield* TestClock.adjust(1_000);
      yield* drain(a, before);

      const after = yield* connect("b", bob);
      yield* TestClock.adjust(1_000);
      expect(yield* Queue.take(after.updates)).toEqual({ members: [online(alice)] });
      yield* before.close;
      expect(yield* sizesAfter(1_000, a, after)).toEqual([0, 0]);

      yield* after.report({ viewingThreadId: threadY });
      yield* TestClock.adjust(1_000);
      expect(yield* Queue.take(a.updates)).toEqual({
        viewers: [
          { threadId: threadY, memberIds: [bob] },
          { threadId: threadX, memberIds: [] },
        ],
      });
    }).pipe(Effect.scoped, Effect.provide(Presence.layer)),
  );
});
