import { MemberId, MessageId, RunId, type TeamMember } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  discardedTurnAuthors,
  othersTurnStarterId,
  resolveComposerDispatchMode,
} from "./composerDispatch.ts";

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
    {
      row: "Alice's turn, seen by Alice",
      authorId: alice,
      me: alice,
      members: team,
      starter: null,
    },
    {
      row: "an agent run belongs to the holder",
      authorId: undefined,
      me: bob,
      members: team,
      starter: alice,
    },
    {
      row: "a reassigned thread's agent run",
      authorId: undefined,
      me: bob,
      members: team,
      ownerId: bob,
      starter: null,
    },
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

describe("discardedTurnAuthors", () => {
  const carol = MemberId.make("carol");
  const trio = new Map([...team, [carol, member(carol, false)]]);
  type Turn = { readonly ordinal: number; readonly author: MemberId; readonly status?: string };
  const turnsOf = (turns: ReadonlyArray<Turn>) => ({
    runs: turns.map((turn) => ({
      id: RunId.make(`run-${turn.ordinal}`),
      ordinal: turn.ordinal,
      status: (turn.status ?? "completed") as "completed",
      userMessageId: MessageId.make(`message-${turn.ordinal}`),
    })),
    messages: turns.map((turn) => ({
      id: MessageId.make(`message-${turn.ordinal}`),
      role: "user",
      runId: RunId.make(`run-${turn.ordinal}`),
      authorId: turn.author,
    })),
  });

  it.each([
    { row: "only my turns", turns: [{ ordinal: 2, author: alice }], expected: [] },
    {
      row: "mixed turns count per member",
      turns: [
        { ordinal: 2, author: bob },
        { ordinal: 3, author: alice },
        { ordinal: 4, author: carol },
        { ordinal: 5, author: bob },
      ],
      expected: [
        { memberId: bob, count: 2 },
        { memberId: carol, count: 1 },
      ],
    },
    {
      row: "rolled-back and cancelled runs are ignored",
      turns: [
        { ordinal: 2, author: bob, status: "rolled_back" },
        { ordinal: 3, author: bob, status: "cancelled" },
        { ordinal: 4, author: carol },
      ],
      expected: [{ memberId: carol, count: 1 }],
    },
    {
      row: "a single-member server",
      members: solo,
      turns: [{ ordinal: 2, author: bob }],
      expected: [],
    },
    {
      row: "turns the projection no longer holds come from messages",
      held: 1,
      turns: [
        { ordinal: 2, author: bob },
        { ordinal: 3, author: carol },
        { ordinal: 4, author: bob },
      ],
      expected: [
        { memberId: bob, count: 2 },
        { memberId: carol, count: 1 },
      ],
    },
  ])("$row", ({ turns, expected, members = trio, held = turns.length }) => {
    const { runs, messages } = turnsOf(turns);
    expect(
      discardedTurnAuthors({
        projection: { thread: { ownerId: null }, runs: runs.slice(runs.length - held) },
        messages,
        targetTurnCount: 1,
        members,
        me: alice,
      }),
    ).toEqual(expected);
  });
});
