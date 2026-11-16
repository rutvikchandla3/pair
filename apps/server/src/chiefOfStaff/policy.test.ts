import { expect, it } from "@effect/vitest";

import { DEFAULT_CONFIRM_TOOLS } from "@t3tools/contracts";

import { isRiskyCall, summarizeCallArgs } from "./policy.ts";

it("treats every default tool as risky", () => {
  for (const tool of DEFAULT_CONFIRM_TOOLS) {
    expect(isRiskyCall(tool, {}, DEFAULT_CONFIRM_TOOLS)).toBe(true);
  }
});

it("leaves an ordinary tool alone", () => {
  expect(isRiskyCall("t3_thread_send", { text: "hi" }, DEFAULT_CONFIRM_TOOLS)).toBe(false);
});

it("does not ask for a default tool the member removed", () => {
  expect(isRiskyCall("task_cancel", {}, [])).toBe(false);
});

it("treats archiving through t3_thread_organize as risky", () => {
  expect(isRiskyCall("t3_thread_organize", { action: "archive" }, DEFAULT_CONFIRM_TOOLS)).toBe(
    true,
  );
});

it("leaves the harmless t3_thread_organize actions alone", () => {
  expect(isRiskyCall("t3_thread_organize", { action: "pin" }, DEFAULT_CONFIRM_TOOLS)).toBe(false);
  expect(isRiskyCall("t3_thread_organize", { action: "unarchive" }, DEFAULT_CONFIRM_TOOLS)).toBe(
    false,
  );
});

it("treats an archive or delete action on t3_thread_update as risky", () => {
  expect(isRiskyCall("t3_thread_update", { action: "archive" }, DEFAULT_CONFIRM_TOOLS)).toBe(true);
  expect(isRiskyCall("t3_thread_update", { action: "delete" }, DEFAULT_CONFIRM_TOOLS)).toBe(true);
  expect(isRiskyCall("t3_thread_update", { action: "rename" }, DEFAULT_CONFIRM_TOOLS)).toBe(false);
});

it("survives a missing or non-object argument list", () => {
  expect(isRiskyCall("t3_thread_organize", undefined, DEFAULT_CONFIRM_TOOLS)).toBe(false);
  expect(isRiskyCall("t3_thread_organize", "archive", DEFAULT_CONFIRM_TOOLS)).toBe(false);
});

it("honors a member's extra tool", () => {
  expect(isRiskyCall("t3_thread_send", {}, ["t3_thread_send"])).toBe(true);
});

it("summarizes arguments for the card and redacts secrets", () => {
  expect(summarizeCallArgs({ projectId: "project:1", force: true })).toBe(
    "projectId=project:1, force=true",
  );
  expect(summarizeCallArgs({ token: "abc", name: "x" })).toBe("token=[redacted], name=x");
  expect(summarizeCallArgs("plain")).toBe("");
  expect(summarizeCallArgs({ blob: "x".repeat(400) }).length).toBe(200);
});
