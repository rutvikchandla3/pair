import { MessageId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { TimelineEntry } from "../../session-logic";
import {
  deriveMessagesTimelineRows,
  resolveBotFocusRowIndex,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";

const time = (second: number) => new Date(Date.UTC(2026, 10, 18, 10, 0, second)).toISOString();

const wake = (id: string, run: string, second: number, summary: string): TimelineEntry => ({
  kind: "work",
  id,
  createdAt: time(second),
  entry: {
    id,
    runId: RunId.make(run),
    createdAt: time(second),
    label: summary,
    tone: "info",
    itemType: "notification",
  },
});

const tool = (
  id: string,
  run: string,
  second: number,
  name: string,
  input: unknown = {},
): TimelineEntry => ({
  kind: "work",
  id,
  createdAt: time(second),
  entry: {
    id,
    runId: RunId.make(run),
    createdAt: time(second),
    label: name,
    tone: "tool",
    itemType: "dynamic_tool",
    toolLifecycleStatus: "completed",
    structuredPayload: {
      type: "dynamic_tool",
      toolName: `mcp__t3-code__${name}`,
      input,
    } as Extract<
      NonNullable<Extract<TimelineEntry, { kind: "work" }>["entry"]["structuredPayload"]>,
      { type: "dynamic_tool" }
    >,
  },
});

const message = (
  id: string,
  role: "user" | "assistant",
  run: string | null,
  second: number,
): TimelineEntry => ({
  kind: "message",
  id,
  createdAt: time(second),
  message: {
    id: MessageId.make(id),
    role,
    text: id,
    runId: run === null ? null : RunId.make(run),
    createdAt: time(second),
    updatedAt: time(second),
    streaming: false,
  },
});

function rows(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  options: { botName?: string; expanded?: ReadonlyArray<string> } = {},
): MessagesTimelineRow[] {
  const lastRun = timelineEntries
    .map((entry) =>
      entry.kind === "message"
        ? entry.message.runId
        : entry.kind === "work"
          ? entry.entry.runId
          : null,
    )
    .findLast((runId) => runId != null);
  return deriveMessagesTimelineRows({
    timelineEntries,
    latestRun: lastRun
      ? { runId: lastRun, status: "completed", startedAt: time(0), completedAt: time(59) }
      : null,
    isWorking: false,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    expandedRunIds: new Set((options.expanded ?? []).map((runId) => RunId.make(runId))),
    ...(options.botName === undefined ? {} : { botName: options.botName }),
  });
}

const folds = (result: ReadonlyArray<MessagesTimelineRow>) =>
  result.flatMap((row) => (row.kind === "turn-fold" ? [row] : []));

describe("bot home thread folds", () => {
  it("labels a wake turn's fold with the wake and hides the wake row", () => {
    const entries = [
      wake("wake-a", "a", 10, "Rate limit threads API is waiting"),
      tool("brief-a", "a", 11, "bot_brief"),
      message("reply-a", "assistant", "a", 12),
    ];
    const collapsed = rows(entries, { botName: "Atlas" });
    expect(collapsed.map((row) => row.id)).toEqual(["turn-fold:a", "reply-a"]);
    expect(folds(collapsed)[0]).toMatchObject({
      label: "Rate limit threads API is waiting",
      wake: { startedAt: time(10) },
    });
    expect(folds(collapsed)[0]?.wake?.memoryNote).toBeUndefined();

    const expanded = rows(entries, { botName: "Atlas", expanded: ["a"] }).map((row) => row.id);
    expect(expanded.slice(0, 2)).toEqual(["turn-fold:a", "wake-a"]);
    expect(expanded).toContain("reply-a");
    expect(expanded.indexOf("reply-a")).toBeGreaterThan(expanded.indexOf("wake-a"));
  });

  it("keeps a wake row when its turn hid nothing else or left nothing", () => {
    expect(
      rows(
        [
          wake("wake-a", "a", 10, "Sidebar drag flicker finished"),
          message("done", "assistant", "a", 11),
        ],
        {
          botName: "Atlas",
        },
      ).map((row) => row.id),
    ).toEqual(["turn-fold:a", "done"]);
    expect(
      rows([wake("wake-a", "a", 10, "Session is quiet")], { botName: "Atlas" }).map(
        (row) => row.id,
      ),
    ).toEqual(["turn-fold:a"]);
  });

  it("counts memory answers in the label", () => {
    const once = rows(
      [
        wake("wake-a", "a", 10, "Sidebar drag flicker asked a question"),
        tool("respond-a", "a", 11, "bot_session_respond"),
      ],
      { botName: "Atlas" },
    );
    expect(folds(once)[0]?.wake?.memoryNote).toBe("answered from memory");
    const twice = rows(
      [
        wake("wake-a", "a", 10, "2 updates"),
        tool("respond-a", "a", 11, "bot_session_respond"),
        tool("respond-b", "a", 12, "bot_session_respond"),
      ],
      { botName: "Atlas" },
    );
    expect(folds(twice)[0]?.wake?.memoryNote).toBe("answered 2 from memory");
  });

  it("merges back-to-back quiet wake turns into one fold", () => {
    const entries = [
      wake("wake-a", "a", 10, "A finished"),
      tool("brief-a", "a", 11, "bot_brief"),
      wake("wake-b", "b", 20, "B is waiting"),
      tool("respond-b", "b", 21, "bot_session_respond"),
      wake("wake-c", "c", 30, "C is quiet"),
      tool("update-c", "c", 31, "bot_job_update", { headline: "still going" }),
    ];
    const collapsed = rows(entries, { botName: "Atlas" });
    expect(collapsed.map((row) => row.id)).toEqual(["turn-fold:bot-updates:a"]);
    expect(folds(collapsed)[0]).toMatchObject({
      label: "Atlas handled 3 updates",
      wake: {
        startedAt: time(10),
        endedAt: time(30),
        memoryNote: "answered 1 from memory",
        memberRunIds: ["a", "b", "c"],
      },
    });

    const opened = rows(entries, { botName: "Atlas", expanded: ["bot-updates:a"] });
    expect(opened.map((row) => row.id)).toEqual([
      "turn-fold:bot-updates:a",
      "turn-fold:a",
      "turn-fold:b",
      "turn-fold:c",
    ]);
    expect(folds(opened)[2]).toMatchObject({
      label: "B is waiting",
      wake: { memoryNote: "answered from memory" },
    });
    const member = rows(entries, { botName: "Atlas", expanded: ["bot-updates:a", "b"] });
    expect(member.map((row) => row.id)).toContain("respond-b");
  });

  it.each([
    ["a user message", [message("you", "user", null, 15)]],
    ["a reply", [wake("wake-x", "x", 15, "X finished"), message("reply-x", "assistant", "x", 16)]],
    ["an ask", [wake("wake-x", "x", 15, "X is waiting"), tool("ask-x", "x", 16, "bot_ask")]],
    ["a learned note", [wake("wake-x", "x", 15, "X"), tool("learn-x", "x", 16, "bot_learn")]],
    ["a forgotten note", [wake("wake-x", "x", 15, "X"), tool("forget-x", "x", 16, "bot_forget")]],
    [
      "a finished job",
      [wake("wake-x", "x", 15, "X"), tool("done-x", "x", 16, "bot_job_update", { status: "done" })],
    ],
  ])("ends a quiet run at %s", (_, between) => {
    const result = rows(
      [
        wake("wake-a", "a", 10, "A finished"),
        tool("brief-a", "a", 11, "bot_brief"),
        ...between,
        wake("wake-b", "b", 20, "B finished"),
        tool("brief-b", "b", 21, "bot_brief"),
      ],
      { botName: "Atlas" },
    );
    expect(folds(result).map((row) => row.label)).not.toContain("Atlas handled 2 updates");
    expect(folds(result).some((row) => row.wake?.memberRunIds !== undefined)).toBe(false);
    expect(result.map((row) => row.id)).toEqual(
      expect.arrayContaining(["turn-fold:a", "turn-fold:b"]),
    );
  });

  it("never hides a message in a turn that asked the user", () => {
    const entries = [
      message("you", "user", "a", 10),
      tool("ask-a", "a", 11, "bot_ask"),
      message("question", "assistant", "a", 12),
      tool("brief-a", "a", 13, "bot_brief"),
      message("after", "assistant", "a", 14),
    ];
    const ids = rows(entries, { botName: "Atlas" }).map((row) => row.id);
    expect(ids).toContain("question");
    expect(ids).toContain("after");
    expect(rows(entries).map((row) => row.id)).not.toContain("question");
  });

  it("leaves other threads' folds unchanged", () => {
    const entries = [
      wake("wake-a", "a", 10, "Subagent finished"),
      tool("brief-a", "a", 11, "bot_brief"),
      message("reply-a", "assistant", "a", 12),
      wake("wake-b", "b", 20, "Monitor reported new output"),
      tool("read-b", "b", 21, "read"),
      wake("wake-c", "c", 30, "Monitor reported new output"),
      tool("read-c", "c", 31, "read"),
    ];
    const result = rows(entries);
    expect(result.map((row) => row.id)).toEqual([
      "wake-a",
      "turn-fold:a",
      "reply-a",
      "wake-b",
      "turn-fold:b",
      "wake-c",
      "turn-fold:c",
    ]);
    expect(folds(result).every((row) => row.label.startsWith("Worked") && !row.wake)).toBe(true);
  });

  it("focuses a turn's last message, else its fold row or the merged row holding it", () => {
    const result = rows(
      [
        message("you", "user", null, 5),
        wake("wake-a", "a", 10, "A finished"),
        tool("brief-a", "a", 11, "bot_brief"),
        wake("wake-b", "b", 20, "B finished"),
        tool("brief-b", "b", 21, "bot_brief"),
        wake("wake-c", "c", 30, "C finished"),
        message("reply-c", "assistant", "c", 31),
      ],
      { botName: "Atlas" },
    );
    const focused = (run: string) => result[resolveBotFocusRowIndex(result, RunId.make(run))]?.id;
    expect(focused("c")).toBe("reply-c");
    expect(focused("b")).toBe("turn-fold:bot-updates:a");
    const opened = rows(
      [wake("wake-a", "a", 10, "A finished"), tool("brief-a", "a", 11, "bot_brief")],
      { botName: "Atlas" },
    );
    expect(opened[resolveBotFocusRowIndex(opened, RunId.make("a"))]?.id).toBe("turn-fold:a");
  });
});
