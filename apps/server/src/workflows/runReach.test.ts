import { describe, expect, it } from "@effect/vitest";

import type { ThreadViewer } from "../orchestration-v2/MemberThreadView.ts";
import { mayReadRun } from "./runReach.ts";

const viewer = (open: ReadonlySet<string>) =>
  ({
    memberId: "member-grace",
    access: { allowsThreadId: (threadId: string) => open.has(threadId) },
  }) as unknown as ThreadViewer;

const step = (threadId: string | null, environmentId: string | null = null) => ({
  threadId,
  environmentId,
});

describe("mayReadRun", () => {
  it("shows a member a run only through threads they can open, and an admin every run", () => {
    const grace = viewer(new Set(["thread-open"]));
    expect(mayReadRun(grace, false, { steps: [step("thread-open")] })).toBe(true);
    expect(mayReadRun(grace, false, { steps: [step("thread-open"), step("thread-hidden")] })).toBe(
      false,
    );
    // A trigger, webhook or schedule start ran in no thread here: admins only.
    expect(mayReadRun(grace, false, { steps: [step(null)] })).toBe(false);
    expect(mayReadRun(grace, false, { steps: [step("thread-open", "environment-box")] })).toBe(
      false,
    );
    expect(mayReadRun(grace, true, { steps: [step(null)] })).toBe(true);
    // Without thread access to enforce, every run is open as every thread is.
    expect(mayReadRun(null, false, { steps: [] })).toBe(true);
  });
});
