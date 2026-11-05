import { MemberId, MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { canChangeQueuedRun, runStarterId } from "./threadCollaboration.ts";

const alice = MemberId.make("alice");
const bob = MemberId.make("bob");
const carol = MemberId.make("carol");
const run = { userMessageId: MessageId.make("start") };

describe("runStarterId", () => {
  it.each([
    {
      row: "the author of the run's message",
      messages: [{ id: run.userMessageId, authorId: bob }],
      starter: bob,
    },
    {
      row: "the holder for an authorless message",
      messages: [{ id: run.userMessageId }],
      starter: alice,
    },
    {
      row: "the holder when the message is not loaded",
      messages: [{ id: MessageId.make("other"), authorId: bob }],
      starter: alice,
    },
  ])("$row", ({ messages, starter }) => {
    expect(runStarterId({ run, messages, holderId: alice })).toBe(starter);
  });
});

describe("canChangeQueuedRun", () => {
  it.each([
    {
      row: "Bob controls Alice's queued run",
      action: "control",
      actorId: bob,
      starterId: alice,
      allowed: false,
    },
    {
      row: "Bob edits Alice's queued text",
      action: "edit",
      actorId: bob,
      starterId: alice,
      allowed: false,
    },
    {
      row: "owner Alice controls Bob's queued run",
      action: "control",
      actorId: alice,
      starterId: bob,
      allowed: true,
    },
    {
      row: "owner Alice edits Bob's queued text",
      action: "edit",
      actorId: alice,
      starterId: bob,
      allowed: false,
    },
    { row: "Bob controls his own", action: "control", actorId: bob, starterId: bob, allowed: true },
    { row: "Bob edits his own", action: "edit", actorId: bob, starterId: bob, allowed: true },
    {
      row: "Carol controls Bob's queued run",
      action: "control",
      actorId: carol,
      starterId: bob,
      allowed: false,
    },
    {
      row: "a command with no actor",
      action: "edit",
      actorId: undefined,
      starterId: bob,
      allowed: true,
    },
    {
      row: "a solo server",
      action: "edit",
      actorId: alice,
      starterId: bob,
      teamMode: false,
      allowed: true,
    },
  ] as const)("$row", ({ action, actorId, starterId, allowed, ...row }) => {
    expect(
      canChangeQueuedRun({
        action,
        actorId,
        holderId: alice,
        starterId,
        teamMode: "teamMode" in row ? row.teamMode : true,
      }),
    ).toBe(allowed);
  });
});
