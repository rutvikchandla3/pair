import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  MemberId,
  MessageId,
  type OrchestrationV2SpaceCommand,
  ProjectId,
  type Space,
  SpaceId,
  ThreadId,
} from "@t3tools/contracts";

import { decideSpaceCommand, type SpaceDecision } from "./SpaceDecisions.ts";

const owner = MemberId.make("member:owner");
const member = MemberId.make("member:member");
const outsider = MemberId.make("member:outsider");
const spaceId = SpaceId.make("spc_0123456789abcdef0123");
const roomThreadId = ThreadId.make("thread:room");
const now = "2026-11-12T10:00:00.000Z";

const space: Space = {
  id: spaceId,
  roomThreadId,
  name: "Question creation",
  brief: "",
  projectId: ProjectId.make("project:a"),
  ownerId: owner,
  members: [
    { memberId: owner, joinedAt: now, addedBy: null, removedAt: null },
    { memberId: member, joinedAt: now, addedBy: owner, removedAt: null },
  ],
  joinRequests: [],
  pairBilling: { type: "team" },
  createdBy: owner,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  archivedBy: null,
};

type Change = { readonly type: OrchestrationV2SpaceCommand["type"] } & Record<string, unknown>;
const decide = (change: Change, actorId: MemberId, at: Space = space): SpaceDecision =>
  decideSpaceCommand({
    command: {
      commandId: CommandId.make("command"),
      threadId: roomThreadId,
      spaceId,
      actorId,
      ...change,
    } as OrchestrationV2SpaceCommand,
    space: at,
    now,
  });
const outcome = (decision: SpaceDecision) =>
  decision._tag === "Refuse" ? decision.reason : decision._tag;

const post: Change = {
  type: "space.post",
  messageId: MessageId.make("message:1"),
  text: "hello",
  mentions: [],
  authorKind: "user",
};

// The "Who can do what" table in docs/product/spaces.md.
const table: ReadonlyArray<readonly [string, Change, string, string, string]> = [
  // action, change, owner, member, non-member
  ["post", post, "Accept", "Accept", "not-member"],
  ["edit the Brief", { type: "space.update", brief: "New" }, "Accept", "Accept", "not-member"],
  ["rename", { type: "space.update", name: "Renamed" }, "Accept", "not-owner", "not-member"],
  [
    "change the project",
    { type: "space.update", projectId: ProjectId.make("project:b") },
    "Accept",
    "not-owner",
    "not-member",
  ],
  [
    "change who pays",
    { type: "space.update", pairBilling: { type: "member", memberId: member } },
    "Accept",
    "not-owner",
    "not-member",
  ],
  [
    "add members",
    { type: "space.member.add", memberIds: [outsider] },
    "Accept",
    "not-owner",
    "not-owner",
  ],
  [
    "remove members",
    { type: "space.member.remove", memberId: member },
    "Accept",
    "not-owner",
    "not-owner",
  ],
  [
    "transfer ownership",
    { type: "space.owner.transfer", ownerId: member },
    "Accept",
    "not-owner",
    "not-owner",
  ],
  ["archive", { type: "space.archive" }, "Accept", "not-owner", "not-owner"],
  ["leave", { type: "space.leave" }, "owner-cannot-leave", "Accept", "NoOp"],
  ["request to join", { type: "space.join.request" }, "NoOp", "NoOp", "Accept"],
  ["cancel a request", { type: "space.join.cancel" }, "no-request", "no-request", "no-request"],
];

describe("decideSpaceCommand", () => {
  it.each(table)("%s", (_action, change, asOwner, asMember, asOutsider) => {
    expect([
      outcome(decide(change, owner)),
      outcome(decide(change, member)),
      outcome(decide(change, outsider)),
    ]).toEqual([asOwner, asMember, asOutsider]);
  });

  it("an archived space is read-only except for its owner's unarchive", () => {
    const archived = { ...space, archivedAt: now, archivedBy: owner };
    expect(outcome(decide(post, member, archived))).toBe("archived");
    expect(outcome(decide({ type: "space.update", brief: "x" }, owner, archived))).toBe("archived");
    expect(outcome(decide({ type: "space.unarchive" }, member, archived))).toBe("not-owner");
    expect(outcome(decide({ type: "space.unarchive" }, owner, archived))).toBe("Accept");
  });

  it("only a person's post tags @pair, and mentions keep active members only", () => {
    const tag = { ...post, mentions: [{ type: "pair" }, { type: "pair" }] };
    const human = decide(tag, member);
    const agent = decide({ ...tag, authorKind: "agent" }, member);
    expect(human._tag === "Accept" ? human.pairReply : null).toEqual({
      postId: "message:1",
      taggerId: member,
    });
    expect(agent._tag === "Accept" ? agent.pairReply : "refused").toBeNull();
    const mentions = decide(
      {
        ...post,
        mentions: [
          { type: "member", memberId: outsider },
          { type: "member", memberId: owner },
        ],
      },
      member,
    );
    expect(
      mentions._tag === "Accept" && mentions.entries[0]?.type === "post"
        ? mentions.entries[0].mentions
        : null,
    ).toEqual([{ type: "member", memberId: owner }]);
  });

  it("a removed member who comes back by Undo keeps their joinedAt; a re-add does not", () => {
    const removed: Space = {
      ...space,
      members: [
        space.members[0]!,
        { ...space.members[1]!, joinedAt: "2026-01-01T00:00:00.000Z", removedAt: now },
      ],
    };
    const joinedAt = (decision: SpaceDecision) =>
      decision._tag === "Accept"
        ? decision.space?.members.find((m) => m.memberId === member)?.joinedAt
        : null;
    expect(
      joinedAt(
        decide({ type: "space.member.add", memberIds: [member], restore: true }, owner, removed),
      ),
    ).toBe("2026-01-01T00:00:00.000Z");
    expect(
      joinedAt(decide({ type: "space.member.add", memberIds: [member] }, owner, removed)),
    ).toBe(now);
    expect(outcome(decide(post, member, removed))).toBe("not-member");
  });
});
