import {
  ChiefOfStaffSessionId,
  EnvironmentId,
  type ChiefOfStaffCloseReason,
  type ChiefOfStaffEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CHIEF_OF_STAFF_MAX_LINES,
  INITIAL_CHIEF_OF_STAFF_VIEW,
  microphoneErrorMessage,
  reduceChiefOfStaff,
  type ChiefOfStaffAction,
  type ChiefOfStaffView,
} from "./chiefOfStaff.logic";

const environmentId = EnvironmentId.make("env-1");
const sessionId = ChiefOfStaffSessionId.make("session-1");

function run(actions: ReadonlyArray<ChiefOfStaffAction>, from = INITIAL_CHIEF_OF_STAFF_VIEW) {
  return actions.reduce(reduceChiefOfStaff, from);
}

const event = (value: ChiefOfStaffEvent): ChiefOfStaffAction => ({ type: "event", event: value });
const said = (role: "user" | "assistant", text: string, final = false) =>
  event({ _tag: "transcript", role, text, final });

const live = run([
  { type: "start", environmentId },
  { type: "started", sessionId },
  event({ _tag: "state", state: "listening" }),
]);

const texts = (view: ChiefOfStaffView) =>
  view.lines.map((line) => [line.role, line.text, line.final]);

describe("reduceChiefOfStaff", () => {
  it("moves through start, connect and the server's states", () => {
    const starting = run([{ type: "start", environmentId }]);
    expect(starting.phase).toBe("starting");
    expect(starting.environmentId).toBe(environmentId);
    expect(reduceChiefOfStaff(starting, { type: "started", sessionId }).phase).toBe("connecting");
    expect(live.phase).toBe("listening");
    expect(run([event({ _tag: "state", state: "speaking" })], live).phase).toBe("speaking");
  });

  it("ignores a second start and events that arrive before the start RPC answers", () => {
    expect(reduceChiefOfStaff(live, { type: "start", environmentId })).toBe(live);
    const starting = run([{ type: "start", environmentId }]);
    expect(reduceChiefOfStaff(starting, said("user", "hi"))).toBe(starting);
  });

  it("appends deltas to the role's open utterance and lets a final replace them", () => {
    const view = run(
      [
        said("user", "List my"),
        said("user", " threads"),
        said("assistant", "Sure"),
        said("user", "List my threads.", true),
        said("assistant", ", one moment"),
      ],
      live,
    );
    expect(texts(view)).toEqual([
      ["user", "List my threads.", true],
      ["assistant", "Sure, one moment", false],
    ]);
    const next = run([said("assistant", "Sure, one moment.", true), said("user", "Thanks")], view);
    expect(texts(next)).toEqual([
      ["user", "List my threads.", true],
      ["assistant", "Sure, one moment.", true],
      ["user", "Thanks", false],
    ]);
  });

  it("adds a final with no open utterance as its own line and drops empty ones", () => {
    const view = run([said("assistant", "Done.", true), said("user", "  ", true)], live);
    expect(texts(view)).toEqual([["assistant", "Done.", true]]);
    expect(texts(run([said("user", "um"), said("user", "", true)], live))).toEqual([]);
  });

  it("keeps only the latest utterances", () => {
    const view = run(
      Array.from({ length: CHIEF_OF_STAFF_MAX_LINES + 2 }, (_, index) =>
        said(index % 2 === 0 ? "user" : "assistant", `line ${index}`, true),
      ),
      live,
    );
    expect(view.lines).toHaveLength(CHIEF_OF_STAFF_MAX_LINES);
    expect(view.lines.at(-1)?.text).toBe(`line ${CHIEF_OF_STAFF_MAX_LINES + 1}`);
    expect(new Set(view.lines.map((line) => line.id)).size).toBe(CHIEF_OF_STAFF_MAX_LINES);
  });

  it("updates a working item in place when its tool call finishes", () => {
    const working = (status: "started" | "completed" | "failed", id = "call-1") =>
      event({ _tag: "working", id, tool: "list_threads", label: "Listing threads", status });
    const view = run([working("started"), working("started", "call-2"), working("failed")], live);
    expect(view.working).toEqual([
      { id: "call-1", label: "Listing threads", status: "failed" },
      { id: "call-2", label: "Listing threads", status: "started" },
    ]);
  });

  it.each<[{ closeReason?: ChiefOfStaffCloseReason; message?: string }, string | null]>([
    [{ closeReason: "stopped" }, null],
    [{ closeReason: "replaced" }, "Chief of staff moved to another window."],
    [{ closeReason: "ended" }, "The voice session ended."],
    [{ closeReason: "failed" }, "The voice session failed."],
    [{ closeReason: "failed", message: "Sign in to ChatGPT." }, "Sign in to ChatGPT."],
    [{}, "The voice session ended."],
  ])("closes with %o and shows %s", (fields, message) => {
    const view = run([event({ _tag: "state", state: "closed", ...fields })], live);
    expect(view.phase).toBe("closed");
    expect(view.closeReason).toBe(fields.closeReason ?? "ended");
    expect(view.message).toBe(message);
    expect(run([said("user", "late")], view)).toBe(view);
  });

  it("keeps the transcript of a closed session until the next start clears it", () => {
    const closed = run([said("user", "hi", true), { type: "stopped" }], live);
    expect(closed.phase).toBe("closed");
    expect(closed.lines).toHaveLength(1);
    const restarted = run([{ type: "start", environmentId }], closed);
    expect(restarted.lines).toEqual([]);
    expect(restarted.message).toBeNull();
    expect(
      run([{ type: "started", sessionId }, said("user", "again")], restarted).lines[0]?.id,
    ).not.toBe(closed.lines[0]?.id);
  });

  it("records a local failure once and leaves a closed session alone", () => {
    const failed = run([{ type: "failed", message: "No microphone was found." }], live);
    expect([failed.phase, failed.closeReason, failed.message]).toEqual([
      "closed",
      "failed",
      "No microphone was found.",
    ]);
    expect(reduceChiefOfStaff(failed, { type: "failed", message: "later" })).toBe(failed);
    expect(reduceChiefOfStaff(failed, { type: "stopped" })).toBe(failed);
    expect(reduceChiefOfStaff(failed, { type: "muted", muted: true })).toBe(failed);
  });

  it("mutes only a live session and unmutes on the next start", () => {
    const muted = reduceChiefOfStaff(live, { type: "muted", muted: true });
    expect(muted.muted).toBe(true);
    const next = run([{ type: "stopped" }, { type: "start", environmentId }], muted);
    expect(next.muted).toBe(false);
  });
});

describe("microphoneErrorMessage", () => {
  it("explains a denied permission and falls back for unknown failures", () => {
    expect(microphoneErrorMessage(new DOMException("denied", "NotAllowedError"))).toMatch(
      /blocked/,
    );
    expect(microphoneErrorMessage(new Error("boom"))).toBe(
      "The microphone could not start. Try again.",
    );
  });
});
