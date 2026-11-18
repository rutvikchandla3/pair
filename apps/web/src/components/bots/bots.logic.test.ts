import {
  BotAskId,
  BotEventId,
  BotId,
  BotJobId,
  BOT_ESCALATE_AFTER_MS,
  type Bot,
  type BotAsk,
  type BotEvent,
  type BotJob,
  type BotNote,
  type BotSession,
  type BotsSnapshot,
  type EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import {
  answeredAsks,
  botSummary,
  decisionsSince,
  escalatedSession,
  formatClockTime,
  headlineChanged,
  jobGroups,
  jobProgress,
  needsYouCount,
  quietMinutes,
  sessionState,
  sessionStateLabel,
  endSentence,
  plainPreview,
} from "./bots.logic";

const ENV = "env_00000000000000000001" as EnvironmentId;
const BOT = BotId.make("bot-1");
const JOB = BotJobId.make("job-1");
const THREAD = ThreadId.make("thread-1");
const PROJECT = ProjectId.make("project-1");
const NOW = Date.parse("2026-11-18T14:00:00.000Z");

function shell(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    id: THREAD,
    environmentId: ENV,
    updatedAt: new Date(NOW).toISOString(),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    blockedOnThreadWait: false,
    runtime: null,
    latestRun: null,
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

function session(overrides: Partial<BotSession> = {}): BotSession {
  return {
    threadId: THREAD,
    botId: BOT,
    jobId: JOB,
    role: "worker",
    title: "Implement",
    projectId: PROJECT,
    takenOver: false,
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function job(overrides: Partial<BotJob> = {}): BotJob {
  return {
    id: JOB,
    botId: BOT,
    number: 1,
    title: "A job",
    request: "Do the thing",
    projectId: null,
    status: "working",
    headline: "",
    headlineAt: null,
    pullRequests: [],
    report: null,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    finishedAt: null,
    ...overrides,
  };
}

function ask(overrides: Partial<BotAsk> = {}): BotAsk {
  return {
    id: BotAskId.make("ask-1"),
    botId: BOT,
    jobId: JOB,
    question: "Which one?",
    why: "Because.",
    options: [],
    pick: null,
    status: "open",
    answerKind: null,
    answer: null,
    remember: false,
    noteId: null,
    createdAt: new Date(NOW).toISOString(),
    answeredAt: null,
    ...overrides,
  };
}

function event(overrides: Partial<BotEvent> = {}): BotEvent {
  return {
    id: BotEventId.make("event-1"),
    botId: BOT,
    jobId: JOB,
    kind: "decision",
    text: "Decided",
    sessionThreadId: null,
    decision: null,
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function snapshot(overrides: Partial<BotsSnapshot> = {}): BotsSnapshot {
  return {
    bots: [] as ReadonlyArray<Bot>,
    jobs: [] as ReadonlyArray<BotJob>,
    sessions: [] as ReadonlyArray<BotSession>,
    asks: [] as ReadonlyArray<BotAsk>,
    notes: [] as ReadonlyArray<BotNote>,
    events: [] as ReadonlyArray<BotEvent>,
    revision: 0,
    ...overrides,
  };
}

describe("sessionState", () => {
  it("reads a taken-over session first", () => {
    expect(sessionState(session({ takenOver: true }), shell(), NOW).kind).toBe("taken-over");
  });

  it("waits on a pending request", () => {
    expect(sessionState(session(), shell({ hasPendingUserInput: true }), NOW).kind).toBe("waiting");
    expect(sessionState(session(), shell({ hasPendingApprovals: true }), NOW).kind).toBe("waiting");
  });

  it("pauses at a usage limit", () => {
    const state = sessionState(
      session(),
      shell({
        runtime: {
          status: "failed",
          lastErrorClass: "usage_limit",
          usageLimitResetAt: "2026-11-18T14:00:00.000Z",
        },
      } as unknown as Partial<EnvironmentThreadShell>),
      NOW,
    );
    expect(state).toEqual({ kind: "paused-until", until: "2026-11-18T14:00:00.000Z" });
  });

  it("fails otherwise", () => {
    expect(
      sessionState(
        session(),
        shell({
          runtime: { status: "failed", lastErrorClass: null },
        } as unknown as Partial<EnvironmentThreadShell>),
        NOW,
      ).kind,
    ).toBe("failed");
  });

  it("reads done, stopped and working", () => {
    expect(
      sessionState(session(), shell({ runtime: { status: "completed" } } as never), NOW).kind,
    ).toBe("done");
    expect(
      sessionState(session(), shell({ runtime: { status: "interrupted" } } as never), NOW).kind,
    ).toBe("stopped");
    expect(
      sessionState(session(), shell({ runtime: { status: "running" } } as never), NOW).kind,
    ).toBe("working");
  });

  it("calls a working session quiet after 30 minutes", () => {
    const state = sessionState(
      session(),
      shell({
        updatedAt: new Date(NOW - 34 * 60_000).toISOString(),
        runtime: { status: "running" } as never,
      }),
      NOW,
    );
    expect(state.kind).toBe("quiet");
    expect(quietMinutes(state.quietMs ?? 0)).toBe(34);
  });

  it("treats a missing shell as working", () => {
    expect(sessionState(session(), null, NOW).kind).toBe("working");
  });
});

describe("jobProgress", () => {
  it("says no sessions yet", () => {
    expect(jobProgress(job(), [], undefined, NOW)).toEqual({
      label: "No sessions yet",
      warning: false,
    });
  });

  it("counts done sessions", () => {
    const sessions = [
      session({ threadId: ThreadId.make("t-done") }),
      session({ threadId: ThreadId.make("t-work") }),
    ];
    const shells = new Map<string, EnvironmentThreadShell | null>([
      ["t-done", shell({ id: ThreadId.make("t-done"), runtime: { status: "completed" } as never })],
      ["t-work", shell({ id: ThreadId.make("t-work"), runtime: { status: "running" } as never })],
    ]);
    expect(jobProgress(job(), sessions, shells, NOW)).toEqual({
      label: "1 of 2 sessions done",
      warning: false,
    });
  });

  it("names the worst session in order", () => {
    const quiet = session({ threadId: ThreadId.make("t-quiet"), title: "Upgrade web" });
    const took = session({ threadId: ThreadId.make("t-took"), title: "Fix drag", takenOver: true });
    const failed = session({ threadId: ThreadId.make("t-failed"), title: "Implement" });
    const paused = session({ threadId: ThreadId.make("t-paused"), title: "Review" });
    const shells = new Map<string, EnvironmentThreadShell | null>([
      [
        "t-quiet",
        shell({
          id: ThreadId.make("t-quiet"),
          updatedAt: new Date(NOW - 34 * 60_000).toISOString(),
          runtime: { status: "running" } as never,
        }),
      ],
      ["t-took", shell({ id: ThreadId.make("t-took") })],
      [
        "t-failed",
        shell({
          id: ThreadId.make("t-failed"),
          runtime: { status: "failed", lastErrorClass: null } as never,
        }),
      ],
      [
        "t-paused",
        shell({
          id: ThreadId.make("t-paused"),
          runtime: {
            status: "failed",
            lastErrorClass: "usage_limit",
            usageLimitResetAt: new Date(2026, 10, 18, 15, 0).toISOString(),
          } as never,
        }),
      ],
    ]);
    expect(jobProgress(job(), [quiet, took, failed, paused], shells, NOW)).toEqual({
      label: "You took over",
      warning: true,
    });
    expect(jobProgress(job(), [quiet, failed, paused], shells, NOW).label).toBe("Implement failed");
    expect(jobProgress(job(), [quiet, paused], shells, NOW).label).toBe(
      "Review paused until 15:00",
    );
    expect(jobProgress(job(), [quiet], shells, NOW).label).toBe("Upgrade web quiet 34m");
  });
});

describe("needsYouCount and botSummary", () => {
  const data = snapshot({
    jobs: [
      job({ id: JOB, number: 1, status: "working" }),
      job({
        id: BotJobId.make("job-2"),
        number: 2,
        status: "done",
        finishedAt: new Date(NOW).toISOString(),
      }),
    ],
    sessions: [
      session({ threadId: ThreadId.make("t1") }),
      session({ threadId: ThreadId.make("t2") }),
    ],
    asks: [ask({ status: "open" }), ask({ id: BotAskId.make("ask-2"), status: "answered" })],
  });
  const shells = new Map<string, EnvironmentThreadShell | null>([
    ["t1", shell({ id: ThreadId.make("t1"), runtime: { status: "running" } as never })],
    ["t2", shell({ id: ThreadId.make("t2"), runtime: { status: "completed" } as never })],
  ]);

  it("counts only open asks", () => {
    expect(needsYouCount(data, BOT, shells, NOW)).toBe(1);
  });

  it("counts an escalated session request", () => {
    const threadId = ThreadId.make("t-escalated");
    const stale = shell({
      id: threadId,
      hasPendingUserInput: true,
      updatedAt: new Date(NOW - BOT_ESCALATE_AFTER_MS - 60_000).toISOString(),
    });
    const escalatedData = snapshot({ sessions: [session({ threadId })] });
    const escalated = escalatedData.sessions[0];
    if (escalated === undefined) throw new Error("missing session");
    expect(escalatedSession(escalated, stale, NOW)).toBe(true);
    expect(needsYouCount(escalatedData, BOT, new Map([[threadId, stale]]), NOW)).toBe(1);
  });

  it("summarises exactly what the rows show", () => {
    const summary = botSummary(data, BOT, shells, NOW);
    expect(summary).toEqual({
      jobs: 2,
      sessionsWorking: 1,
      needYou: 1,
      label: "2 jobs · 1 session working · 1 need you",
    });
    expect(data.jobs.length).toBe(summary.jobs);
    expect(data.asks.filter((entry) => entry.status === "open").length).toBe(summary.needYou);
  });

  it("says no jobs yet", () => {
    expect(botSummary(snapshot(), BOT, undefined, NOW).label).toBe("No jobs yet");
  });
});

describe("decisionsSince and headlineChanged", () => {
  it("keeps decisions newer than the mark", () => {
    const events = [
      event({ id: BotEventId.make("e1"), createdAt: "2026-11-18T13:00:00.000Z" }),
      event({ id: BotEventId.make("e2"), createdAt: "2026-11-18T14:30:00.000Z" }),
      event({ id: BotEventId.make("e3"), kind: "job-done", createdAt: "2026-11-18T15:00:00.000Z" }),
    ];
    expect(decisionsSince(events, "2026-11-18T13:30:00.000Z").map((row) => row.id)).toEqual(["e2"]);
    expect(decisionsSince(events, null)).toHaveLength(2);
  });

  it("marks a headline that moved", () => {
    expect(
      headlineChanged(job({ headlineAt: "2026-11-18T14:00:00.000Z" }), "2026-11-18T13:00:00.000Z"),
    ).toBe(true);
    expect(
      headlineChanged(job({ headlineAt: "2026-11-18T12:00:00.000Z" }), "2026-11-18T13:00:00.000Z"),
    ).toBe(false);
    expect(headlineChanged(job({ headlineAt: null }), null)).toBe(false);
  });
});

describe("jobGroups", () => {
  it("splits in progress, done this week and all", () => {
    const jobs = [
      job({ id: BotJobId.make("j1"), number: 1, status: "working" }),
      job({
        id: BotJobId.make("j2"),
        number: 2,
        status: "done",
        finishedAt: new Date(NOW - 2 * 24 * 60 * 60_000).toISOString(),
      }),
      job({
        id: BotJobId.make("j3"),
        number: 3,
        status: "done",
        finishedAt: new Date(NOW - 40 * 24 * 60 * 60_000).toISOString(),
      }),
      job({ id: BotJobId.make("j4"), number: 4, status: "stopped" }),
    ];
    const groups = jobGroups(jobs, NOW);
    expect(groups.inProgress.map((entry) => entry.number)).toEqual([1]);
    expect(groups.doneThisWeek.map((entry) => entry.number)).toEqual([2]);
    expect(groups.all.map((entry) => entry.number)).toEqual([4, 3, 2, 1]);
  });
});

describe("labels", () => {
  it("formats the paused clock time and answered order", () => {
    const until = new Date(2026, 10, 18, 15, 0).toISOString();
    expect(formatClockTime(until)).toBe("15:00");
    const answered = [
      ask({ id: BotAskId.make("a1"), status: "answered", answeredAt: "2026-11-18T13:00:00.000Z" }),
      ask({ id: BotAskId.make("a2"), status: "answered", answeredAt: "2026-11-18T14:00:00.000Z" }),
    ];
    expect(answeredAsks(snapshot({ asks: answered }), BOT).map((entry) => entry.id)).toEqual([
      "a2",
      "a1",
    ]);
  });

  it("writes session state copy", () => {
    expect(sessionStateLabel({ kind: "waiting" })).toBe("Waiting on Atlas");
    expect(
      sessionStateLabel({
        kind: "paused-until",
        until: new Date(2026, 10, 18, 14, 0).toISOString(),
      }),
    ).toBe("Paused until 14:00");
  });
});

describe("plainPreview", () => {
  it("drops markdown headings, emphasis and code ticks", () => {
    expect(plainPreview("Done.\n## Report\n**What changed** - Fixed `list()`")).toBe(
      "Done. Report What changed - Fixed list()",
    );
  });
});

describe("endSentence", () => {
  it("adds a full stop only when the text has none", () => {
    expect(endSentence("30 requests a minute.")).toBe("30 requests a minute.");
    expect(endSentence("Per user")).toBe("Per user.");
  });
});
