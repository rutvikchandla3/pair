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
  botInitial,
  botSessionState,
  botSummaryLine,
  groupJobs,
  jobHeadline,
  jobProgressLabel,
  needsYouCount,
  timeOfDay,
  worstSessionState,
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
    threadId: ThreadId.make(`thread:${jobId}`),
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
  return { kind: "working", label: "", trouble: false, ...overrides };
}

const stateFor = (overrides: Parameters<typeof botSessionState>[0]["shell"], takenOver = false) =>
  botSessionState({
    session: session(BotJobIdSchema.make("job:1"), { takenOver }),
    shell: overrides,
    botName: "Atlas",
    nowMs,
  });

describe("groupJobs", () => {
  it("keeps working jobs newest first and drops stopped and older done jobs", () => {
    const groups = groupJobs(
      [
        job({ number: 12, status: "working" }),
        job({ number: 14, status: "working" }),
        job({
          number: 13,
          status: "done",
          finishedAt: "2026-11-17T09:00:00.000Z",
        }),
        job({
          number: 11,
          status: "done",
          finishedAt: "2026-11-01T09:00:00.000Z",
        }),
        job({ number: 10, status: "stopped", finishedAt: "2026-11-17T09:00:00.000Z" }),
      ],
      nowMs,
    );
    expect(groups.inProgress.map((entry) => entry.number)).toEqual([14, 12]);
    expect(groups.doneThisWeek.map((entry) => entry.number)).toEqual([13]);
  });
});

describe("jobHeadline", () => {
  it("falls back to Waiting for the bot until the first update", () => {
    expect(jobHeadline(job({ number: 1 }), "Atlas")).toBe("Waiting for Atlas");
    expect(jobHeadline(job({ number: 1, headline: "  " }), "Atlas")).toBe("Waiting for Atlas");
    expect(jobHeadline(job({ number: 1, headline: "  Moving the tests  " }), "Atlas")).toBe(
      "Moving the tests",
    );
  });
});

describe("botInitial", () => {
  it("uses the first letter, upper-cased", () => {
    expect(botInitial("Atlas")).toBe("A");
    expect(botInitial("  zed")).toBe("Z");
    expect(botInitial("")).toBe("?");
  });
});

describe("botSessionState", () => {
  it("taken over wins over a failed shell", () => {
    expect(stateFor(shell({ lastError: "boom" }), true)).toEqual({
      kind: "taken-over",
      label: "You took over",
      trouble: true,
    });
  });

  it("an unloaded shell is working with nothing to say", () => {
    expect(stateFor(null)).toEqual({ kind: "working", label: "", trouble: false });
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

describe("worstSessionState", () => {
  it("picks the lowest severity and returns null when empty", () => {
    expect(worstSessionState([])).toBeNull();
    expect(
      worstSessionState([
        state({ kind: "working" }),
        state({ kind: "failed" }),
        state({ kind: "taken-over" }),
      ])?.kind,
    ).toBe("taken-over");
    expect(worstSessionState([state({ kind: "done" }), state({ kind: "paused" })])?.kind).toBe(
      "paused",
    );
  });
});

describe("jobProgressLabel", () => {
  it("counts done sessions when nothing is in trouble", () => {
    expect(
      jobProgressLabel([
        state({ kind: "done" }),
        state({ kind: "done" }),
        state({ kind: "working" }),
      ]),
    ).toBe("2 of 3 sessions done");
  });

  it("names the worst session when one is in trouble", () => {
    expect(
      jobProgressLabel([
        state({ kind: "working" }),
        state({ kind: "quiet", label: "Upgrade web quiet 34m", trouble: true }),
      ]),
    ).toBe("Upgrade web quiet 34m");
  });

  it("has nothing to show with no sessions", () => {
    expect(jobProgressLabel([])).toBeNull();
  });
});

describe("needsYouCount", () => {
  it("counts only open asks", () => {
    const ask = (overrides: Partial<BotAsk>): BotAsk => ({
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
      createdAt: "2026-11-18T09:00:00.000Z",
      answeredAt: null,
      ...overrides,
    });
    expect(needsYouCount([ask({}), ask({ status: "answered" })])).toBe(1);
    expect(needsYouCount([])).toBe(0);
  });
});

describe("botSummaryLine", () => {
  it("joins the parts and drops the empty ones", () => {
    expect(
      botSummaryLine({
        jobCount: 5,
        sessionStates: [
          state({ kind: "working" }),
          state({ kind: "working" }),
          state({ kind: "working" }),
        ],
        needsYou: 2,
      }),
    ).toBe("5 jobs · 3 sessions working · 2 need you");
    expect(botSummaryLine({ jobCount: 1, sessionStates: [], needsYou: 0 })).toBe("1 job");
  });
});

describe("timeOfDay", () => {
  it("formats the local time and passes an unparsable value through", () => {
    expect(timeOfDay(new Date(2024, 0, 1, 9, 5).toISOString())).toBe("09:05");
    expect(timeOfDay("nonsense")).toBe("nonsense");
  });
});
