import { describe, expect, it } from "@effect/vitest";
import { MemberId } from "@t3tools/contracts";

import {
  SENDER_NOTE,
  labelUserMessageForProvider,
  labelUserTextForProvider,
} from "./SenderLabel.ts";

const alice = MemberId.make("member-alice");
const members = new Map([[alice, { name: "Alice" }]]);

describe("labelUserTextForProvider", () => {
  it.each([
    { label: undefined, expected: "Fix the build" },
    { label: "name", expected: "Message from Alice:\n\nFix the build" },
    {
      label: "name_with_note",
      expected: `${SENDER_NOTE}\n\nMessage from Alice:\n\nFix the build`,
    },
  ] as const)("labels $label", ({ label, expected }) => {
    expect(labelUserTextForProvider("Fix the build", label, "Alice")).toBe(expected);
  });
});

describe("labelUserMessageForProvider", () => {
  it.each([
    { message: { authorId: alice }, expected: "Fix the build" },
    { message: { authorId: alice, senderLabel: "name" }, expected: "Message from Alice:\n\nFix the build" },
    {
      message: { authorId: MemberId.make("member-unknown"), senderLabel: "name" },
      expected: "Message from a former member:\n\nFix the build",
    },
  ] as const)("resolves the sender of $message", ({ message, expected }) => {
    expect(labelUserMessageForProvider("Fix the build", message, members)).toBe(expected);
  });
});
