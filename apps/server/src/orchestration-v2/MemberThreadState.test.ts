import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MemberId,
  OrchestrationV2AppThreadJson,
  OrchestrationV2ThreadShellJson,
  type OrchestrationV2DomainEvent,
  ThreadId,
  type ThreadMemberState,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  clearedForSettle,
  EMPTY_MEMBER_STATE,
  followedView,
  hasPersonalState,
  personalStateOf,
  transferHolder,
  viewFor,
  withPersonalState,
  viewThreadEvent,
} from "./MemberThreadState.ts";

const owner = MemberId.make("member-owner");
const alice = MemberId.make("member-alice");
const bob = MemberId.make("member-bob");
const at = (iso: string) => DateTime.makeUnsafe(iso);

const base = {
  id: "thread-1",
  projectId: "project-1",
  title: "Thread",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: "thread-1", parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  pinnedAt: "2026-10-01T01:00:00.000Z",
  pinOrderKey: "a0",
  lastVisitedAt: "2026-10-01T02:00:00.000Z",
  snoozedUntil: "2026-10-02T00:00:00.000Z",
  snoozedAt: "2026-10-01T03:00:00.000Z",
};
const thread = Schema.decodeUnknownSync(OrchestrationV2AppThreadJson)({
  ...base,
  lastSnoozeWakeAt: "2026-10-01T00:30:00.000Z",
});
const shell = Schema.decodeUnknownSync(OrchestrationV2ThreadShellJson)({
  ...base,
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

const decodeLink = Schema.decodeSync(ThreadPullRequestLink);

const aliceState: ThreadMemberState = {
  ...EMPTY_MEMBER_STATE,
  activeOrderKey: "b1",
  lastVisitedAt: at("2026-10-01T05:00:00.000Z"),
  lastSnoozeWakeAt: at("2026-10-01T04:00:00.000Z"),
};

const event = (
  type: "thread.pinned" | "thread.metadata-updated",
  member?: { memberId: MemberId; state: ThreadMemberState },
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event-${type}`),
  threadId: ThreadId.make("thread-1"),
  occurredAt: at("2026-10-01T06:00:00.000Z"),
  type,
  payload: thread,
  ...(member ? { member } : {}),
});

describe("MemberThreadState", () => {
  it("viewFor returns the row for the holder and a null viewer", () => {
    assert.strictEqual(viewFor(thread, owner, aliceState, owner), thread);
    assert.strictEqual(viewFor(shell, null, aliceState, owner), shell);
    const owned = { ...thread, ownerId: alice };
    assert.strictEqual(viewFor(owned, alice, null, owner), owned);
  });

  it("viewFor overlays the member row, or empty state, for a non-holder", () => {
    assert.deepStrictEqual(personalStateOf(viewFor(thread, alice, aliceState, owner)), aliceState);
    assert.deepStrictEqual(personalStateOf(viewFor(thread, bob, null, owner)), EMPTY_MEMBER_STATE);
    const overlaid = viewFor(shell, alice, aliceState, owner);
    assert.deepStrictEqual(personalStateOf(overlaid), { ...aliceState, lastSnoozeWakeAt: null });
    assert.isFalse("lastSnoozeWakeAt" in overlaid);
    assert.strictEqual(overlaid.title, shell.title);
  });

  it("withPersonalState writes followedAt only when set", () => {
    const followedAt = at("2026-10-01T07:00:00.000Z");
    assert.isFalse("followedAt" in viewFor(thread, alice, aliceState, owner));
    const following = viewFor(shell, alice, { ...aliceState, followedAt }, owner);
    assert.deepStrictEqual(following.followedAt, followedAt);
    assert.isFalse("followedAt" in withPersonalState(following, aliceState));
  });

  it("followedView baselines an unset visit and keeps an existing follow", () => {
    const now = at("2026-10-01T07:00:00.000Z");
    const fresh = followedView(viewFor(thread, bob, null, owner), now);
    assert.deepStrictEqual([fresh.followedAt, fresh.lastVisitedAt], [now, now]);
    const visited = followedView(viewFor(thread, alice, aliceState, owner), now);
    assert.deepStrictEqual(visited.lastVisitedAt, aliceState.lastVisitedAt);
    assert.strictEqual(followedView(visited, at("2026-10-01T08:00:00.000Z")), visited);
  });

  it("viewThreadEvent drops other members' events and strips the viewer's own", () => {
    const pinned = event("thread.pinned", { memberId: alice, state: aliceState });
    assert.deepStrictEqual(viewThreadEvent(pinned, bob, owner, null), { event: null, cache: null });
    assert.isNull(viewThreadEvent(pinned, null, owner, null).event);
    assert.isNull(viewThreadEvent(pinned, owner, owner, null).event);

    const own = viewThreadEvent(pinned, alice, owner, null);
    assert.strictEqual(own.cache, aliceState);
    assert.isFalse("member" in own.event!);
    assert.strictEqual(own.event!.type, "thread.pinned");
  });

  it("viewThreadEvent overlays shared thread events with cached state and passes the rest", () => {
    const shared = event("thread.metadata-updated");
    const forAlice = viewThreadEvent(shared, alice, owner, aliceState);
    assert.strictEqual(forAlice.cache, aliceState);
    assert.deepStrictEqual(
      forAlice.event?.type === "thread.metadata-updated" && personalStateOf(forAlice.event.payload),
      aliceState,
    );
    const forBob = viewThreadEvent(shared, bob, owner, null);
    assert.deepStrictEqual(
      forBob.event?.type === "thread.metadata-updated" && personalStateOf(forBob.event.payload),
      EMPTY_MEMBER_STATE,
    );
    assert.strictEqual(viewThreadEvent(shared, owner, owner, aliceState).event, shared);
    assert.strictEqual(viewThreadEvent(shared, null, owner, aliceState).event, shared);

    const linkUpdated: OrchestrationV2DomainEvent = {
      id: EventId.make("event-link"),
      threadId: ThreadId.make("thread-1"),
      occurredAt: at("2026-10-01T06:00:00.000Z"),
      type: "thread.pull-request-link-updated",
      payload: decodeLink({
        host: "github.com",
        repository: "o/r",
        number: 1,
        url: "https://github.com/o/r/pull/1",
        source: "manual",
        linkedAt: "2026-10-01T00:00:00.000Z",
        snapshot: null,
        stack: null,
      }),
    };
    assert.strictEqual(viewThreadEvent(linkUpdated, alice, owner, aliceState).event, linkUpdated);
  });

  it("transferHolder swaps row and member state, leaving the old holder following", () => {
    const now = at("2026-10-01T07:00:00.000Z");
    const aliceFollowing = { ...aliceState, followedAt: at("2026-10-01T06:30:00.000Z") };
    const { row, demoted } = transferHolder(thread, owner, aliceFollowing, now);
    assert.deepStrictEqual(personalStateOf(row), aliceState);
    assert.isFalse("followedAt" in row);
    assert.deepStrictEqual(demoted, {
      memberId: owner,
      state: { ...personalStateOf(thread), followedAt: now },
    });
    assert.deepStrictEqual(
      personalStateOf(transferHolder(thread, owner, null, now).row),
      EMPTY_MEMBER_STATE,
    );
  });

  it("hasPersonalState counts pins, orders and snoozes but not visits, opens or follows", () => {
    assert.isFalse(hasPersonalState(EMPTY_MEMBER_STATE));
    const followOnly = { ...EMPTY_MEMBER_STATE, followedAt: at("2026-10-01T07:00:00.000Z") };
    assert.isFalse(hasPersonalState(followOnly));
    assert.deepStrictEqual(clearedForSettle(followOnly), followOnly);
    assert.isTrue(hasPersonalState(aliceState));
    const cleared = clearedForSettle(personalStateOf(thread));
    assert.isFalse(hasPersonalState(cleared));
    assert.deepStrictEqual(cleared.lastVisitedAt, thread.lastVisitedAt);
    assert.deepStrictEqual(cleared.lastSnoozeWakeAt, thread.lastSnoozeWakeAt);
  });
});
