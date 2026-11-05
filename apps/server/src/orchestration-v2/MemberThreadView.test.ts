import { assert, describe, it } from "@effect/vitest";
import {
  type ApplicationStoredEvent,
  MemberId,
  OrchestrationV2AppThreadJson,
  OrchestrationV2DomainEventJson,
  type OrchestrationV2DomainEvent,
  OrchestrationV2ThreadShellJson,
  ThreadId,
  type ThreadMemberState,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EMPTY_MEMBER_STATE } from "./MemberThreadState.ts";
import { makeThreadEventView, overlayForViewer, type ThreadViewer } from "./MemberThreadView.ts";
import { isOtherMembersShellEvent } from "./ShellStream.ts";

const owner = MemberId.make("member-owner");
const alice = MemberId.make("member-alice");
const bob = MemberId.make("member-bob");
const ownersPin = "2026-10-01T01:00:00.000Z";
const alicesPin = "2026-10-03T00:00:00.000Z";

const shellJson = (id: string) => ({
  id,
  projectId: "project-1",
  title: "Thread",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  pinnedAt: ownersPin,
  pinOrderKey: "a0",
});
const decodeShellJson = Schema.decodeUnknownSync(OrchestrationV2ThreadShellJson);
const decodeShell = (fields: object) =>
  decodeShellJson({
    ...fields,
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
  });
const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson);
const ownersThread = decodeShell(shellJson("thread-owner"));
const ownersAppThread = Schema.decodeUnknownSync(OrchestrationV2AppThreadJson)(
  shellJson("thread-owner"),
);
const alicesThread = decodeShell({ ...shellJson("thread-alice"), ownerId: alice });
const alicesState: ThreadMemberState = {
  ...EMPTY_MEMBER_STATE,
  pinnedAt: DateTime.makeUnsafe(alicesPin),
  pinOrderKey: "b0",
};

const viewerWith = (
  memberId: MemberId,
  states: ReadonlyMap<ThreadId, ThreadMemberState>,
  reads: Array<ReadonlyArray<ThreadId>>,
): ThreadViewer => ({
  memberId,
  serverOwnerId: owner,
  readMemberStates: (threadIds) =>
    Effect.sync(() => {
      reads.push(threadIds);
      return states;
    }),
});

const pinned = (memberId?: MemberId, pinnedAt = alicesPin): OrchestrationV2DomainEvent =>
  decodeEvent({
    id: `event-pin-${memberId ?? "holder"}`,
    type: "thread.pinned",
    threadId: "thread-owner",
    occurredAt: pinnedAt,
    payload: { ...shellJson("thread-owner"), pinnedAt, lastSnoozeWakeAt: null },
    ...(memberId === undefined
      ? {}
      : {
          member: {
            memberId,
            state: {
              pinnedAt,
              pinOrderKey: null,
              activeOrderKey: null,
              lastVisitedAt: null,
              snoozedUntil: null,
              snoozedAt: null,
              lastSnoozeWakeAt: null,
              opens: null,
            },
          },
        }),
  });

describe("isOtherMembersShellEvent", () => {
  const stored = (event: OrchestrationV2DomainEvent): ApplicationStoredEvent => ({
    sequence: 1,
    commandId: null,
    event,
  });
  it("drops only member events that belong to someone else", () => {
    assert.isTrue(isOtherMembersShellEvent(stored(pinned(bob)), alice));
    assert.isFalse(isOtherMembersShellEvent(stored(pinned(alice)), alice));
    assert.isFalse(isOtherMembersShellEvent(stored(pinned()), alice));
    assert.isTrue(isOtherMembersShellEvent(stored(pinned(alice)), null));
  });
});

describe("overlayForViewer", () => {
  it.effect("reads member rows once, for the threads the viewer does not hold", () =>
    Effect.gen(function* () {
      const reads: Array<ReadonlyArray<ThreadId>> = [];
      const rows = [ownersThread, alicesThread];
      const viewed = yield* overlayForViewer(
        viewerWith(alice, new Map([[ownersThread.id, alicesState]]), reads),
        rows,
      );
      assert.deepEqual(reads, [[ownersThread.id]]);
      assert.deepEqual(viewed[0]?.pinnedAt, alicesState.pinnedAt);
      assert.equal(viewed[0]?.pinOrderKey, "b0");
      assert.strictEqual(viewed[1], alicesThread);

      const bobsView = yield* overlayForViewer(viewerWith(bob, new Map(), reads), rows);
      assert.isNull(bobsView[0]?.pinnedAt);
      assert.isNull(bobsView[1]?.pinnedAt);
    }),
  );

  it.effect("returns the same rows without a read for the holder and for guests", () =>
    Effect.gen(function* () {
      const reads: Array<ReadonlyArray<ThreadId>> = [];
      const rows = [ownersThread];
      assert.strictEqual(yield* overlayForViewer(viewerWith(owner, new Map(), reads), rows), rows);
      assert.strictEqual(yield* overlayForViewer(null, rows), rows);
      assert.deepEqual(reads, []);
    }),
  );
});

describe("makeThreadEventView", () => {
  it.effect("shows a non-holder their own state across the snapshot, replay and live events", () =>
    Effect.gen(function* () {
      const reads: Array<ReadonlyArray<ThreadId>> = [];
      const view = makeThreadEventView(
        viewerWith(alice, new Map([[ownersThread.id, alicesState]]), reads),
        ownersThread.id,
      );
      const thread = yield* view.thread(ownersAppThread);
      assert.deepEqual(thread.pinnedAt, alicesState.pinnedAt);

      // The holder's own pin keeps showing Alice's state.
      const holders = yield* view.event(pinned(undefined, ownersPin));
      assert.isTrue(holders !== null && holders.type === "thread.pinned");
      if (holders?.type !== "thread.pinned") return;
      assert.deepEqual(holders.payload.pinnedAt, alicesState.pinnedAt);
      assert.notProperty(holders, "member");

      assert.isNull(yield* view.event(pinned(bob)));

      const own = yield* view.event(pinned(alice, "2026-10-04T00:00:00.000Z"));
      assert.isTrue(own !== null && !("member" in own));
      assert.deepEqual(reads, [[ownersThread.id]]);
    }),
  );

  it.effect("never gives a guest a member event", () =>
    Effect.gen(function* () {
      const view = makeThreadEventView(null, ownersThread.id);
      assert.isNull(yield* view.event(pinned(alice)));
      const holders = pinned();
      assert.strictEqual(yield* view.event(holders), holders);
    }),
  );
});
