import {
  ComputeDriverId,
  MemberId,
  RunId,
  TeamImageBuildId,
  ThreadId,
  type TeamImageBuild,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  shouldNotifyMember,
  teamImageBuildNotification,
  threadNotificationTitle,
  type ThreadNotificationEvent,
  type ThreadNotificationKind,
} from "./threadNotificationRouting.ts";

const alice = MemberId.make("alice");
const bob = MemberId.make("bob");
const carol = MemberId.make("carol");
const team = (memberId: MemberId) => ({ memberId, teamMode: true });

const AGENT_KINDS = [
  "completion",
  "failed",
  "limited",
  "machine-failed",
  "approval",
  "input",
] as const;
const ALL_KINDS: ReadonlyArray<ThreadNotificationKind> = [
  ...AGENT_KINDS,
  "request",
  "message",
  "assigned",
  "archived",
];

// Alice owns the thread; Bob is another member; Carol follows it (neither owner nor prompter).
const recipients = (event: ThreadNotificationEvent) =>
  [alice, bob, carol].filter((memberId) => shouldNotifyMember(event, team(memberId)));

describe("shouldNotifyMember", () => {
  it.each([
    ...AGENT_KINDS.map((kind) => ({
      row: `${kind} of Bob's turn`,
      event: { kind, actorId: null, prompterId: bob, ownerId: alice },
      notified: [alice, bob],
    })),
    ...AGENT_KINDS.map((kind) => ({
      row: `${kind} of Alice's turn`,
      event: { kind, actorId: null, prompterId: alice, ownerId: alice },
      notified: [alice],
    })),
    {
      row: "guest request",
      event: { kind: "request", actorId: null, prompterId: bob, ownerId: alice },
      notified: [alice],
    },
    {
      row: "Bob messages Alice's thread",
      event: { kind: "message", actorId: bob, prompterId: null, ownerId: alice },
      notified: [alice],
    },
    {
      row: "Alice messages her own thread",
      event: { kind: "message", actorId: alice, prompterId: null, ownerId: alice },
      notified: [],
    },
    {
      row: "Alice assigns her thread to Bob",
      event: { kind: "assigned", actorId: alice, prompterId: null, ownerId: bob },
      notified: [bob],
    },
    {
      row: "Bob takes Alice's thread himself",
      event: { kind: "assigned", actorId: bob, prompterId: null, ownerId: bob },
      notified: [],
    },
    {
      row: "Bob archives Alice's thread",
      event: { kind: "archived", actorId: bob, prompterId: null, ownerId: alice },
      notified: [alice],
    },
    {
      row: "Alice archives her own thread",
      event: { kind: "archived", actorId: alice, prompterId: null, ownerId: alice },
      notified: [],
    },
  ] satisfies ReadonlyArray<{
    row: string;
    event: ThreadNotificationEvent;
    notified: ReadonlyArray<MemberId>;
  }>)("$row", ({ event, notified }) => {
    expect(recipients(event)).toEqual(notified);
  });

  it("never notifies anyone of their own action, even the owner or prompter", () => {
    for (const kind of ALL_KINDS) {
      expect(
        shouldNotifyMember(
          { kind, actorId: alice, prompterId: alice, ownerId: alice },
          team(alice),
        ),
      ).toBe(false);
    }
  });

  it("never pings a follower", () => {
    for (const kind of ALL_KINDS) {
      expect(
        shouldNotifyMember({ kind, actorId: bob, prompterId: bob, ownerId: alice }, team(carol)),
      ).toBe(false);
    }
  });

  it("solo notifies every agent event and none of the member's own actions", () => {
    for (const viewer of [
      { memberId: alice, teamMode: false },
      { memberId: null, teamMode: true },
    ]) {
      const solo = ALL_KINDS.filter((kind) =>
        shouldNotifyMember({ kind, actorId: alice, prompterId: bob, ownerId: bob }, viewer),
      );
      expect(solo).toEqual([...AGENT_KINDS, "request"]);
    }
  });
});

describe("threadNotificationTitle", () => {
  it("names the archiver, or another member when unknown", () => {
    expect(threadNotificationTitle("archived", "Alice")).toBe("Archived by Alice");
    expect(threadNotificationTitle("archived", null)).toBe("Archived by another member");
    expect(ALL_KINDS.map((kind) => threadNotificationTitle(kind, "Alice"))).toEqual([
      "Thread completed",
      "Thread failed",
      "Usage limit reached",
      "Machine failed",
      "Approval needed",
      "Input needed",
      "Guest request",
      "New message",
      "Assigned to you",
      "Archived by Alice",
    ]);
  });
});

describe("teamImageBuildNotification", () => {
  const at = DateTime.makeUnsafe("2026-11-10T10:00:00Z");
  const build = (change: Partial<TeamImageBuild>): TeamImageBuild => ({
    id: TeamImageBuildId.make("tib_00000000000000000015"),
    number: 15,
    status: "succeeded",
    phase: null,
    recipeRevision: 1,
    driverId: ComputeDriverId.make("docker"),
    requestedBy: { kind: "member", memberId: alice },
    activateOnSuccess: true,
    requestedAt: at,
    startedAt: at,
    finishedAt: at,
    imageDeletedAt: null,
    ...change,
  });
  const agentBuild = {
    requestedBy: {
      kind: "agent",
      threadId: ThreadId.make("thread-1"),
      runId: RunId.make("run-1"),
      authorIds: [alice],
    },
    activateOnSuccess: false,
  } as const;

  it.each([
    { row: "a page build", subject: build({}), body: "Build 15 is active." },
    {
      row: "an agent build",
      subject: build(agentBuild),
      body: "Build 15 is ready. Activate it in Team image.",
    },
    {
      row: "a failed install",
      subject: build({ status: "failed", failure: { phase: "install", detail: "", logTail: [] } }),
      body: "Build 15 failed at install.",
    },
  ])("tells $row", ({ subject, body }) => {
    expect(teamImageBuildNotification(subject)).toEqual({ title: "Team image", body });
  });

  it("says nothing of a cancelled build", () => {
    expect(teamImageBuildNotification(build({ status: "cancelled" }))).toBeNull();
  });
});
