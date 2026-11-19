import {
  BotAskId,
  BotId,
  type BotAsk,
  type BotJob,
  type BotJobId,
  BotJobId as BotJobIdSchema,
  type BotSession,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type BotSessionShell,
  type BotSessionState,
  botSessionRows,
  botSessionState,
  botStatusLine,
  needsYouCount,
  timeOfDay,
} from "./botsModel";

const botId = BotId.make("bot:atlas");
const projectId = ProjectId.make("project:one");
const nowMs = Date.parse("2026-11-18T12:00:00.000Z");

function job(overrides: Partial<BotJob> & { number: number }): BotJob {
  return {
    id: BotJobIdSchema.make(`job:${overrides.number}`),
    botId,
    title: `Job ${overrides.number}`,
    request: "Do the thing",
    projectId: null,
    status: "working",
    headline: "",
    headlineAt: null,
    pullRequests: [],
    report: null,
    createdAt: "2026-11-18T09:00:00.000Z",
    updatedAt: "2026-11-18T09:00:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

function session(jobId: BotJobId, overrides: Partial<BotSession> = {}): BotSession {
  return {
    threadId: ThreadId.make(`thread:${jobId}:${overrides.title ?? "Implement"}`),
    botId,
    jobId,
    role: "worker",
    title: "Implement",
    projectId,
    takenOver: false,
    createdAt: "2026-11-18T09:00:00.000Z",
    ...overrides,
  };
}

function ask(overrides: Partial<BotAsk> = {}): BotAsk {
  return {
    id: BotAskId.make("ask:1"),
    botId,
    jobId: null,
    question: "Which?",
    why: "",
    options: [],
    pick: null,
    status: "open",
    answerKind: null,
    answer: null,
    remember: false,
    noteId: null,
    homeRunId: null,
    createdAt: "2026-11-18T09:00:00.000Z",
    answeredAt: null,
    ...overrides,
  };
}

function shell(overrides: Partial<BotSessionShell> = {}): BotSessionShell {
  return {
    status: "running",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    blockedOnThreadWait: false,
    usageLimitResetAt: null,
    lastError: null,
    updatedAt: "2026-11-18T11:59:00.000Z",
    ...overrides,
  };
}

function state(overrides: Partial<BotSessionState>): BotSessionState {
  return { kind: "working", label: "", trouble: false, updatedAt: null, ...overrides };
}

const stateFor = (overrides: Parameters<typeof botSessionState>[0]["shell"], takenOver = false) =>
  botSessionState({
    session: session(BotJobIdSchema.make("job:1"), { takenOver }),
    shell: overrides,
    botName: "Atlas",
    nowMs,
  });

describe("botSessionState", () => {
  it("taken over wins over a failed shell", () => {
    expect(stateFor(shell({ lastError: "boom" }), true)).toEqual({
      kind: "taken-over",
      label: "You took over",
      trouble: true,
      updatedAt: null,
    });
  });

  it("an unloaded shell is working with nothing to say", () => {
    expect(stateFor(null)).toEqual({
      kind: "working",
      label: "",
      trouble: false,
      updatedAt: null,
    });
  });

  it("names a future usage-limit reset as paused until its local time", () => {
    const resetAt = new Date(2026, 10, 19, 14, 0).toISOString();
    expect(stateFor(shell({ usageLimitResetAt: resetAt })).label).toBe(
      "Implement paused until 14:00",
    );
  });

  it("waits on the bot for approvals, questions and thread waits", () => {
    expect(stateFor(shell({ hasPendingApprovals: true })).label).toBe("Waiting on Atlas");
    expect(stateFor(shell({ hasPendingUserInput: true })).kind).toBe("waiting");
    expect(stateFor(shell({ blockedOnThreadWait: true })).kind).toBe("waiting");
  });

  it("fails on an error or a failed run status", () => {
    expect(stateFor(shell({ lastError: "no" }))).toMatchObject({
      kind: "failed",
      label: "Implement failed",
      trouble: true,
    });
    expect(stateFor(shell({ status: "rolled_back" })).kind).toBe("failed");
  });

  it("stops on an interrupted or cancelled run", () => {
    expect(stateFor(shell({ status: "interrupted" }))).toMatchObject({
      kind: "stopped",
      label: "Implement stopped",
      trouble: true,
    });
    expect(stateFor(shell({ status: "cancelled" })).kind).toBe("stopped");
  });

  it("says quiet once a working session has no output for 30 minutes", () => {
    expect(stateFor(shell({ updatedAt: "2026-11-18T11:26:00.000Z" }))).toMatchObject({
      kind: "quiet",
      label: "Implement quiet 34m",
      trouble: true,
    });
    expect(stateFor(shell({ updatedAt: "2026-11-18T11:31:00.000Z" })).kind).toBe("working");
  });

  it("is done once no run is active", () => {
    expect(stateFor(shell({ status: "completed" })).kind).toBe("done");
    expect(stateFor(shell({ status: "idle" })).kind).toBe("done");
  });
});

describe("needsYouCount", () => {
  it("counts only open asks", () => {
    expect(needsYouCount([ask({}), ask({ status: "answered" })])).toBe(1);
    expect(needsYouCount([])).toBe(0);
  });
});

describe("botStatusLine", () => {
  const base = { bot: { paused: false }, asks: [], jobs: [], sessions: [], sessionStates: [] };

  it("names the newest session of the ask's job", () => {
    const jobId = BotJobIdSchema.make("job:1");
    expect(
      botStatusLine({
        ...base,
        asks: [ask({ jobId })],
        jobs: [job({ number: 1, title: "Rate limit threads API" })],
        sessions: [
          session(jobId, { title: "Older session", createdAt: "2026-11-18T08:00:00.000Z" }),
          session(jobId, { title: "Newest session", createdAt: "2026-11-18T10:00:00.000Z" }),
        ],
      }),
    ).toEqual({ text: "Newest session needs you", tone: "input" });
  });

  it("falls back to the job's title when the job has no sessions", () => {
    const jobId = BotJobIdSchema.make("job:1");
    expect(
      botStatusLine({
        ...base,
        asks: [ask({ jobId })],
        jobs: [job({ number: 1, title: "Rate limit threads API" })],
      }),
    ).toEqual({ text: "Rate limit threads API needs you", tone: "input" });
  });

  it("counts several questions", () => {
    expect(
      botStatusLine({
        ...base,
        asks: [ask({ id: BotAskId.make("ask:1") }), ask({ id: BotAskId.make("ask:2") })],
      }),
    ).toEqual({ text: "2 questions for you", tone: "input" });
  });

  it("counts the sessions still working", () => {
    expect(
      botStatusLine({
        ...base,
        sessionStates: [
          state({ kind: "working" }),
          state({ kind: "waiting" }),
          state({ kind: "done" }),
        ],
      }),
    ).toEqual({ text: "2 sessions working", tone: "muted" });
    expect(botStatusLine({ ...base, sessionStates: [state({ kind: "working" })] })).toEqual({
      text: "1 session working",
      tone: "muted",
    });
  });

  it("says nothing is running, and Paused when paused", () => {
    expect(botStatusLine(base)).toEqual({ text: "Nothing running", tone: "idle" });
    expect(botStatusLine({ ...base, bot: { paused: true } })).toEqual({
      text: "Paused",
      tone: "paused",
    });
  });
});

describe("botSessionRows", () => {
  const askedJobId = BotJobIdSchema.make("job:asked");
  const otherJobId = BotJobIdSchema.make("job:other");
  const openAsk = ask({ jobId: askedJobId });

  it("orders needs-you, failed, working, then finished newest first and drops old ones", () => {
    const sessions = [
      session(otherJobId, { title: "Finished older", createdAt: "2026-11-18T07:00:00.000Z" }),
      session(otherJobId, { title: "Working" }),
      session(otherJobId, { title: "Failed" }),
      session(askedJobId, { title: "Needs you" }),
      session(otherJobId, { title: "Finished newer", createdAt: "2026-11-18T08:00:00.000Z" }),
      session(otherJobId, { title: "Too old" }),
    ];
    const states = [
      state({ kind: "done", updatedAt: "2026-11-18T11:00:00.000Z" }),
      state({ kind: "working" }),
      state({ kind: "failed" }),
      state({ kind: "waiting" }),
      state({ kind: "done", updatedAt: "2026-11-18T11:30:00.000Z" }),
      state({ kind: "done", updatedAt: "2026-11-10T11:00:00.000Z" }),
    ];
    expect(
      botSessionRows({ sessions, states, asks: [openAsk], nowMs }).map(
        (row) => `${row.session.title}:${row.bucket}`,
      ),
    ).toEqual([
      "Needs you:needs-you",
      "Failed:failed",
      "Working:working",
      "Finished newer:finished",
      "Finished older:finished",
    ]);
  });

  it("does not mark a finished session as needs-you", () => {
    const rows = botSessionRows({
      sessions: [session(askedJobId, { title: "Finished" })],
      states: [state({ kind: "done", updatedAt: "2026-11-18T11:00:00.000Z" })],
      asks: [openAsk],
      nowMs,
    });
    expect(rows.map((row) => row.bucket)).toEqual(["finished"]);
  });
});

describe("timeOfDay", () => {
  it("formats the local time and passes an unparsable value through", () => {
    expect(timeOfDay(new Date(2024, 0, 1, 9, 5).toISOString())).toBe("09:05");
    expect(timeOfDay("nonsense")).toBe("nonsense");
  });
});
