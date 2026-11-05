import { MemberId, MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runStarterId } from "./threadCollaboration.ts";

const alice = MemberId.make("alice");
const bob = MemberId.make("bob");
const run = { userMessageId: MessageId.make("start") };

describe("runStarterId", () => {
  it.each([
    { row: "the author of the run's message", messages: [{ id: run.userMessageId, authorId: bob }], starter: bob },
    { row: "the holder for an authorless message", messages: [{ id: run.userMessageId }], starter: alice },
    { row: "the holder when the message is not loaded", messages: [{ id: MessageId.make("other"), authorId: bob }], starter: alice },
  ])("$row", ({ messages, starter }) => {
    expect(runStarterId({ run, messages, holderId: alice })).toBe(starter);
  });
});
