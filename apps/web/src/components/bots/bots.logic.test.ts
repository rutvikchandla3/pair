import {
  BotAskId,
  BotId,
  BotJobId,
  type Bot,
  type BotAsk,
  type BotJob,
  type BotSession,
  type BotsSnapshot,
  type EnvironmentId,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import {
  botSessionGlyph,
  botSidebarSessions,
  botStatusLine,
  botFacePose,
  cloudSessionsStillRunning,
  sessionState,
  threadChipState,
} from "./bots.logic";

const ENV = "env_00000000000000000001" as EnvironmentId;
const BOT = BotId.make("bot-1");
const JOB = BotJobId.make("job-1");
const THREAD = ThreadId.make("thread-1");
const PROJECT = ProjectId.make("project-1");
const RUN = RunId.make("run-1");
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
    archivedAt: null,
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
    homeRunId: null,
    createdAt: new Date(NOW).toISOString(),
    answeredAt: null,
    ...overrides,
  };
}

function bot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: BOT,
    ownerId: "member-1" as Bot["ownerId"],
    name: "Atlas",
    color: "#6366f1",
    shape: "round",
    voice: "crisp",
    picture: null,
    charter: "",
    instructions: "",
    limits: [],
    models: {} as Bot["models"],
    homeThreadId: null,
    homeProjectId: null,
    paused: false,
    lastSeenAt: null,
    nextJobNumber: 1,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function cloudSession(
  state: NonNullable<BotSession["cloud"]>["state"],
  overrides: Partial<BotSession> = {},
): BotSession {
  return session({
    cloud: {
      environmentId: "env_cloud" as EnvironmentId,
      label: "Pair Cloud",
      state,
      pendingRequest: null,
      lastOutputAt: new Date(NOW).toISOString(),
      reportedRunId: null,
      reportedRequestIds: [],
      position: 0,
    },
    ...overrides,
  });
}

function snapshot(overrides: Partial<BotsSnapshot> = {}): BotsSnapshot {
  return {
    bots: [bot()],
    jobs: [],
    sessions: [],
    asks: [],
    notes: [],
    events: [],
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

  it("reads done, stopped and working", () => {
    expect(
      sessionState(session(), shell({ runtime: { status: "completed" } as never }), NOW).kind,
    ).toBe("done");
    expect(
      sessionState(session(), shell({ runtime: { status: "interrupted" } as never }), NOW).kind,
    ).toBe("stopped");
    expect(
      sessionState(session(), shell({ runtime: { status: "running" } as never }), NOW).kind,
    ).toBe("working");
  });

  it("reads a run held open by background work as working, not done", () => {
    const parked = (latestRun: { status: string } | null) =>
      shell({ runtime: { status: "idle" } as never, latestRun: latestRun as never });
    expect(sessionState(session(), parked({ status: "running" }), NOW).kind).toBe("working");
    expect(sessionState(session(), parked({ status: "completed" }), NOW).kind).toBe("done");
    expect(sessionState(session(), parked(null), NOW).kind).toBe("done");
  });

  it("treats a missing shell as working", () => {
    expect(sessionState(session(), null, NOW).kind).toBe("working");
  });

  it("reads a cloud session without its shell from its last-read state", () => {
    expect(sessionState(cloudSession("done"), undefined, NOW).kind).toBe("done");
    expect(sessionState(cloudSession("unreachable"), undefined, NOW).kind).toBe("unreachable");
    const quiet = cloudSession("working");
    expect(sessionState(quiet, undefined, NOW + 31 * 60_000).kind).toBe("quiet");
    // A client connected to the cloud holds the fresher shell.
    expect(
      sessionState(
        cloudSession("unreachable"),
        shell({ runtime: { status: "completed" } as never }),
        NOW,
      ).kind,
    ).toBe("done");
  });
});

describe("botStatusLine", () => {
  it("names the newest session of the ask's job", () => {
    const data = snapshot({
      jobs: [job({ title: "Rate limit threads API" })],
      sessions: [
        session({
          threadId: ThreadId.make("older"),
          title: "Older session",
          createdAt: "2026-11-18T10:00:00.000Z",
        }),
        session({
          threadId: ThreadId.make("newer"),
          title: "Rate limit threads API",
          createdAt: "2026-11-18T12:00:00.000Z",
        }),
      ],
      asks: [ask({ homeRunId: RUN })],
    });
    expect(botStatusLine(data, bot(), undefined, NOW)).toEqual({
      kind: "needs",
      label: "Rate limit threads API needs you",
    });
  });

  it("falls back to the job title", () => {
    const data = snapshot({
      jobs: [job({ title: "Upgrade Effect" })],
      asks: [ask()],
    });
    expect(botStatusLine(data, bot(), undefined, NOW)).toEqual({
      kind: "needs",
      label: "Upgrade Effect needs you",
    });
  });

  it("counts several questions", () => {
    const data = snapshot({
      asks: [ask(), ask({ id: BotAskId.make("ask-2") })],
    });
    expect(botStatusLine(data, bot(), undefined, NOW).label).toBe("2 questions for you");
  });

  it("says paused, working, or nothing running", () => {
    expect(botStatusLine(snapshot(), bot({ paused: true }), undefined, NOW).label).toBe("Paused");
    const working = snapshot({ sessions: [session()] });
    const shells = new Map([[THREAD, shell({ runtime: { status: "running" } as never })]]);
    expect(botStatusLine(working, bot(), shells, NOW)).toEqual({
      kind: "text",
      label: "1 session working · nothing needs you",
    });
    expect(botStatusLine(snapshot(), bot(), undefined, NOW).label).toBe("Nothing running");
    const cut = snapshot({
      sessions: [
        cloudSession("working"),
        cloudSession("unreachable", { threadId: ThreadId.make("cut") }),
      ],
    });
    expect(botStatusLine(cut, bot(), undefined, NOW).label).toBe(
      "1 session working · 1 can't be reached",
    );
  });

  it("says working while the bot's own turn runs", () => {
    const home = ThreadId.make("home");
    const shells = new Map([[home, shell({ runtime: { status: "running" } as never })]]);
    expect(botStatusLine(snapshot(), bot({ homeThreadId: home }), shells, NOW).label).toBe(
      "Working…",
    );
  });
});

describe("botSidebarSessions", () => {
  function data(sessions: ReadonlyArray<BotSession>) {
    return snapshot({ sessions, asks: [ask({ jobId: JOB })] });
  }

  it("marks an open ask's session needs-you and orders needs-you, working, failed first", () => {
    const needs = session({ threadId: ThreadId.make("needs"), jobId: JOB });
    const working = session({
      threadId: ThreadId.make("working"),
      jobId: BotJobId.make("job-working"),
    });
    const failed = session({
      threadId: ThreadId.make("failed"),
      jobId: BotJobId.make("job-failed"),
    });
    const shells = new Map<string, EnvironmentThreadShell | null>([
      ["working", shell({ id: ThreadId.make("working"), runtime: { status: "running" } as never })],
      [
        "failed",
        shell({
          id: ThreadId.make("failed"),
          runtime: { status: "failed", lastErrorClass: null } as never,
        }),
      ],
    ]);
    const list = botSidebarSessions(data([failed, working, needs]), BOT, shells, NOW);
    expect(list.rows.map((row) => [row.session.threadId, row.glyph])).toEqual([
      ["needs", "needs-you"],
      ["working", "working"],
      ["failed", "failed"],
    ]);
    expect(list.earlier).toEqual([]);
  });

  it("keeps finished-in-24h newest first and hides older ones behind earlier", () => {
    const fresh = session({
      threadId: ThreadId.make("fresh"),
      createdAt: "2026-11-18T12:00:00.000Z",
    });
    const old = session({
      threadId: ThreadId.make("old"),
      createdAt: "2026-11-15T12:00:00.000Z",
    });
    const shells = new Map<string, EnvironmentThreadShell | null>([
      [
        "fresh",
        shell({
          id: ThreadId.make("fresh"),
          updatedAt: new Date(NOW - 60 * 60_000).toISOString(),
          runtime: { status: "completed" } as never,
        }),
      ],
      [
        "old",
        shell({
          id: ThreadId.make("old"),
          updatedAt: new Date(NOW - 25 * 60 * 60_000).toISOString(),
          runtime: { status: "completed" } as never,
        }),
      ],
    ]);
    const list = botSidebarSessions(snapshot({ sessions: [old, fresh] }), BOT, shells, NOW);
    expect(list.rows.map((row) => row.session.threadId)).toEqual(["fresh"]);
    expect(list.rows[0]?.finishedAt).toBe(new Date(NOW - 60 * 60_000).toISOString());
    expect(list.earlier.map((row) => row.session.threadId)).toEqual(["old"]);
  });

  it("does not mark a finished session needs-you", () => {
    const done = session({ threadId: ThreadId.make("done") });
    const shells = new Map([
      [ThreadId.make("done"), shell({ runtime: { status: "completed" } as never })],
    ]);
    expect(botSessionGlyph(done, job(), shells.get(done.threadId), new Set([JOB]), NOW)).toBe(
      "done",
    );
  });

  it("reads a finished job's sessions from the job when their threads are archived", () => {
    const finishedAt = new Date(NOW - 60 * 60_000).toISOString();
    const stoppedJob = BotJobId.make("job-stopped");
    const data = snapshot({
      jobs: [job({ status: "done", finishedAt }), job({ id: stoppedJob, status: "stopped" })],
      sessions: [
        session({ threadId: ThreadId.make("done") }),
        session({ threadId: ThreadId.make("stopped"), jobId: stoppedJob }),
      ],
    });
    // Archived threads leave the client's shells, so neither session has one.
    const list = botSidebarSessions(data, BOT, new Map(), NOW);
    expect(list.rows.map((row) => [row.session.threadId, row.glyph, row.finishedAt])).toEqual([
      ["stopped", "failed", null],
      ["done", "done", finishedAt],
    ]);
    expect(botFacePose(data, bot(), new Map(), NOW)).toBe("idle");
    expect(botStatusLine(data, bot(), new Map(), NOW).label).toBe("Nothing running");

    // A session that runs again shows its run; one that is done, or has no shell, keeps the job's.
    const running = shell({ runtime: { status: "running" } as never });
    const finished = shell({ runtime: { status: "completed" } as never });
    const glyphOf = (shellOf: typeof running | undefined) =>
      botSidebarSessions(data, BOT, new Map(shellOf ? [[ThreadId.make("done"), shellOf]] : []), NOW)
        .rows.filter((row) => row.session.threadId === "done")
        .map((row) => row.glyph);
    expect(glyphOf(running)).toEqual(["working"]);
    expect(glyphOf(finished)).toEqual(["done"]);
    expect(glyphOf(undefined)).toEqual(["done"]);
  });

  it("moves an archived job or thread behind the disclosure unless it has an open question", () => {
    const asked = BotJobId.make("job-asked");
    const open = BotJobId.make("job-open");
    const openAsked = BotJobId.make("job-open-asked");
    const here = session({ threadId: ThreadId.make("here"), jobId: open });
    const archivedAt = new Date(NOW).toISOString();
    const there = cloudSession("done", { threadId: ThreadId.make("there"), jobId: open });
    const thereAsked = cloudSession("done", {
      threadId: ThreadId.make("there-asked"),
      jobId: openAsked,
    });
    const data = snapshot({
      jobs: [
        job({ status: "done", finishedAt: archivedAt, archivedAt }),
        job({ id: asked, status: "done", finishedAt: archivedAt, archivedAt }),
        job({ id: open, status: "working" }),
        job({ id: openAsked, status: "working" }),
      ],
      sessions: [
        session({ threadId: ThreadId.make("archived") }),
        session({ threadId: ThreadId.make("asked"), jobId: asked }),
        { ...there, cloud: { ...there.cloud!, archived: true } },
        { ...thereAsked, cloud: { ...thereAsked.cloud!, archived: true } },
        { ...here, archived: "failed" },
        session({ threadId: ThreadId.make("here-asked"), jobId: openAsked, archived: "done" }),
      ],
      asks: [ask({ jobId: asked }), ask({ jobId: openAsked })],
    });
    const list = botSidebarSessions(data, BOT, new Map(), NOW);
    expect(list.rows.map((row) => row.session.threadId)).toEqual([
      "asked",
      "there-asked",
      "here-asked",
    ]);
    expect(
      list.archived.map((row) => [
        row.session.threadId,
        row.glyph,
        row.jobFinished,
        row.jobArchived,
      ]),
    ).toEqual([
      ["archived", "done", true, true],
      ["there", "done", false, false],
      ["here", "failed", false, false],
    ]);

    // Unarchived, its shell is back and it returns to the list.
    const unarchived = { ...data, sessions: [here] };
    const shells = new Map([[here.threadId, shell({ id: here.threadId, runtime: null })]]);
    const back = botSidebarSessions(unarchived, BOT, shells, NOW);
    expect(back.rows.map((row) => row.session.threadId)).toEqual(["here"]);
    expect(back.archived).toEqual([]);
  });
});

describe("cloud sessions", () => {
  it("shows an unreachable session offline, among the unfinished ones", () => {
    const rows = botSidebarSessions(
      snapshot({
        sessions: [
          cloudSession("done", { threadId: ThreadId.make("done") }),
          cloudSession("unreachable", { threadId: ThreadId.make("cut") }),
        ],
      }),
      BOT,
      undefined,
      NOW,
    ).rows;
    expect(rows.map((row) => [row.session.threadId, row.glyph])).toEqual([
      ["cut", "offline"],
      ["done", "done"],
    ]);
  });

  it("warns on delete about cloud sessions that keep running there", () => {
    expect(cloudSessionsStillRunning([session(), cloudSession("done")])).toBeNull();
    expect(
      cloudSessionsStillRunning([
        cloudSession("working"),
        cloudSession("unreachable", { threadId: ThreadId.make("cut") }),
      ]),
    ).toBe("2 sessions keep running on Pair Cloud.");
  });
});

describe("botFacePose", () => {
  it("works while the home thread or any session runs, and is idle otherwise", () => {
    const home = ThreadId.make("home");
    const homeBot = bot({ homeThreadId: home });
    expect(
      botFacePose(
        snapshot(),
        homeBot,
        new Map([[home, shell({ runtime: { status: "running" } as never })]]),
        NOW,
      ),
    ).toBe("working");
    const sessionBot = bot();
    const shells = new Map([[THREAD, shell({ runtime: { status: "running" } as never })]]);
    expect(botFacePose(snapshot({ sessions: [session()] }), sessionBot, shells, NOW)).toBe(
      "working",
    );
    expect(botFacePose(snapshot(), sessionBot, undefined, NOW)).toBe("idle");
  });

  it("looks up for an open question before sleeping when paused", () => {
    const working = snapshot({ sessions: [session()], asks: [ask()] });
    const shells = new Map([[THREAD, shell({ runtime: { status: "running" } as never })]]);
    expect(botFacePose(working, bot({ paused: true }), shells, NOW)).toBe("needs-you");
    expect(
      botFacePose(snapshot({ sessions: [session()] }), bot({ paused: true }), shells, NOW),
    ).toBe("paused");
  });
});

describe("threadChipState", () => {
  it("maps the shell to the four chip glyphs", () => {
    expect(threadChipState(null)).toBeNull();
    expect(threadChipState(shell({ hasPendingUserInput: true }))).toBe("input");
    expect(threadChipState(shell({ runtime: { status: "failed" } as never }))).toBe("failed");
    expect(threadChipState(shell({ runtime: { status: "running" } as never }))).toBe("working");
    expect(threadChipState(shell({ runtime: { status: "completed" } as never }))).toBe("done");
    expect(
      threadChipState(
        shell({ runtime: { status: "idle" } as never, latestRun: { status: "running" } as never }),
      ),
    ).toBe("working");
  });
});
