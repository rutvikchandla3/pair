import { MemberId, MessageId, type TeamMember } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { othersTurnStarterId, resolveComposerDispatchMode } from "./composerDispatch.ts";

const alice = MemberId.make("alice");
const bob = MemberId.make("bob");
const member = (id: MemberId, isOwner: boolean): TeamMember => ({
  id,
  name: id,
  role: isOwner ? "admin" : "member",
  color: "hsl(10 60% 50%)",
  isOwner,
  createdAt: "2036-04-07T00:00:00.000Z" as TeamMember["createdAt"],
  removedAt: null,
});
const team = new Map([
  [alice, member(alice, true)],
  [bob, member(bob, false)],
]);
const solo = new Map([[alice, member(alice, true)]]);
const start = MessageId.make("start");
const running = [{ status: "running" as const, userMessageId: start }];

describe("resolveComposerDispatchMode", () => {
  it.each([
    { alternateModifier: false, mode: "queue" },
    { alternateModifier: true, mode: "steer" },
  ])("queues by default on another member's turn (alternate: $alternateModifier)", (row) => {
    expect(
      resolveComposerDispatchMode({
        running: true,
        alternateModifier: row.alternateModifier,
        activeTurnDefault: "queue",
      }),
    ).toBe(row.mode);
  });
});

describe("othersTurnStarterId", () => {
  it.each([
    { row: "Alice's turn, seen by Bob", authorId: alice, me: bob, members: team, starter: alice },
    { row: "Alice's turn, seen by Alice", authorId: alice, me: alice, members: team, starter: null },
    { row: "an agent run belongs to the holder", authorId: undefined, me: bob, members: team, starter: alice },
    { row: "a reassigned thread's agent run", authorId: undefined, me: bob, members: team, ownerId: bob, starter: null },
    { row: "a single-member server", authorId: bob, me: alice, members: solo, starter: null },
    { row: "an idle thread", authorId: alice, me: bob, members: team, runs: [], starter: null },
  ])("$row", ({ authorId, me, members, starter, ownerId = null, runs = running }) => {
    expect(
      othersTurnStarterId({
        projection: {
          thread: { ownerId },
          runs,
          messages: [{ id: start, ...(authorId === undefined ? {} : { authorId }) }],
        },
        members,
        me,
      }),
    ).toBe(starter);
  });
});
