import { MemberId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_PRESENCE,
  applyPresenceSessionEvent,
  applyPresenceUpdate,
  type PresenceSessionState,
} from "./presence.ts";

const bob = MemberId.make("member-bob");
const carol = MemberId.make("member-carol");
const threadX = ThreadId.make("thread-x");
const threadY = ThreadId.make("thread-y");

describe("applyPresenceUpdate", () => {
  it("replaces each key it carries and leaves the rest", () => {
    const viewing = applyPresenceUpdate(EMPTY_PRESENCE, {
      members: [{ memberId: bob, status: "online" }],
      viewers: [
        { threadId: threadX, memberIds: [bob] },
        { threadId: threadY, memberIds: [carol] },
      ],
    });
    const next = applyPresenceUpdate(viewing, {
      members: [{ memberId: bob, status: "away" }],
      viewers: [{ threadId: threadX, memberIds: [] }],
      typing: { threadId: threadY, memberIds: [carol] },
    });

    expect(next.members).toEqual(new Map([[bob, "away"]]));
    expect([...next.viewers.keys()]).toEqual([threadY]);
    expect(next.typing.get(threadY)).toEqual([carol]);
    expect(applyPresenceUpdate(next, { typing: { threadId: threadY, memberIds: [] } }).typing.size).toBe(0);
  });

  it("keeps the identity of values that did not change", () => {
    const state = applyPresenceUpdate(EMPTY_PRESENCE, {
      members: [{ memberId: bob, status: "online" }],
      viewers: [
        { threadId: threadX, memberIds: [bob] },
        { threadId: threadY, memberIds: [carol] },
      ],
    });

    expect(
      applyPresenceUpdate(state, {
        members: [{ memberId: bob, status: "online" }],
        viewers: [{ threadId: threadX, memberIds: [bob] }],
        typing: { threadId: threadX, memberIds: [] },
      }),
    ).toBe(state);

    const next = applyPresenceUpdate(state, { viewers: [{ threadId: threadX, memberIds: [] }] });
    expect(next.members).toBe(state.members);
    expect(next.viewers.get(threadY)).toBe(state.viewers.get(threadY));
  });
});

describe("applyPresenceSessionEvent", () => {
  it("starts each session empty and drops updates from an old one", () => {
    const first = { id: 1 };
    const second = { id: 2 };
    const update = { members: [{ memberId: bob, status: "online" as const }] };
    let state: PresenceSessionState<typeof first> = { session: null, presence: EMPTY_PRESENCE };

    state = applyPresenceSessionEvent(state, first);
    state = applyPresenceSessionEvent(state, first, update);
    expect(state.presence.members.size).toBe(1);
    expect(applyPresenceSessionEvent(state, first)).toBe(state);

    // A reconnect where the server has nothing to say must not keep the old avatars.
    state = applyPresenceSessionEvent(state, second);
    expect(state.presence).toBe(EMPTY_PRESENCE);
    expect(applyPresenceSessionEvent(state, first, update)).toBe(state);

    state = applyPresenceSessionEvent(state, null);
    expect(state.presence).toBe(EMPTY_PRESENCE);
  });
});
