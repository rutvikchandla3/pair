import {
  type Bot,
  BotAskId,
  BotId,
  type BotAsk,
  type BotJob,
  type BotJobId,
  BotJobId as BotJobIdSchema,
  type BotSession,
  type BotsSnapshot,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  type BotsEnvironmentEntry,
  type BotSessionShell,
  type BotSessionState,
  botFacePose,
  botSessionRows,
  botSessionState,
  botSessionShellsKey,
  botsEnvironmentStatus,
  botsScreenModel,
  botsSnapshotOutcome,
  botStatusLine,
  needsYouCount,
  parseBotSessionShellsKey,
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
    archivedAt: null,
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
    job: undefined,
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

  it("reads a finished job's state when its archived thread has no shell", () => {
    const finishedAt = "2026-11-18T11:00:00.000Z";
    const read = (status: BotJob["status"]) =>
      botSessionState({
        session: session(BotJobIdSchema.make("job:1")),
        job: job({ number: 1, status, finishedAt }),
        shell: null,
        botName: "Atlas",
        nowMs,
      });
    expect(read("done")).toEqual(state({ kind: "done", updatedAt: finishedAt }));
    expect(read("stopped")).toEqual(
      state({ kind: "stopped", label: "Implement stopped", trouble: true, updatedAt: finishedAt }),
    );
  });

  it("shows a finished job's session running again as working", () => {
    const read = (status: BotJob["status"], held: BotSessionShell) =>
      botSessionState({
        session: session(BotJobIdSchema.make("job:1")),
        job: job({ number: 1, status, finishedAt: "2026-11-18T11:00:00.000Z" }),
        shell: held,
        botName: "Atlas",
        nowMs,
      }).kind;
    expect(read("done", shell({ status: "running" }))).toBe("working");
    expect(read("stopped", shell({ status: "running" }))).toBe("working");
    expect(read("done", shell({ status: "completed" }))).toBe("done");
    expect(read("stopped", shell({ status: "completed" }))).toBe("stopped");
    const cloud = (state: NonNullable<BotSession["cloud"]>["state"]) =>
      botSessionState({
        session: session(BotJobIdSchema.make("job:1"), {
          cloud: {
            environmentId: "env:cloud" as EnvironmentId,
            label: "Pair Cloud",
            state,
            pendingRequest: null,
            lastOutputAt: "2026-11-18T11:59:00.000Z",
            reportedRunId: null,
            reportedRequestIds: [],
            position: 0,
          },
        }),
        job: job({ number: 1, status: "done", finishedAt: "2026-11-18T11:00:00.000Z" }),
        shell: null,
        botName: "Atlas",
        nowMs,
      }).kind;
    expect(cloud("working")).toBe("working");
    expect(cloud("done")).toBe("done");
  });

  it("reads a cloud session without its shell from its last-read state", () => {
    const cloudSession = (state: NonNullable<BotSession["cloud"]>["state"]) =>
      session(BotJobIdSchema.make("job:1"), {
        cloud: {
          environmentId: "env:cloud" as EnvironmentId,
          label: "Pair Cloud",
          state,
          pendingRequest: null,
          lastOutputAt: "2026-11-18T11:59:00.000Z",
          reportedRunId: null,
          reportedRequestIds: [],
          position: 0,
        },
      });
    const read = (state: NonNullable<BotSession["cloud"]>["state"]) =>
      botSessionState({
        session: cloudSession(state),
        job: undefined,
        shell: null,
        botName: "Atlas",
        nowMs,
      });
    expect(read("unreachable")).toMatchObject({
      kind: "unreachable",
      label: "Can't reach Pair Cloud",
      trouble: true,
    });
    expect(read("waiting").kind).toBe("waiting");
    expect(read("done").kind).toBe("done");
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
          state({ kind: "stopped" }),
        ],
      }),
    ).toEqual({ text: "2 sessions working", tone: "muted" });
    expect(botStatusLine({ ...base, sessionStates: [state({ kind: "working" })] })).toEqual({
      text: "1 session working",
      tone: "muted",
    });
    expect(
      botStatusLine({
        ...base,
        sessionStates: [state({ kind: "working" }), state({ kind: "unreachable" })],
      }),
    ).toEqual({ text: "1 session working · 1 can't be reached", tone: "muted" });
  });

  it("says nothing is running, and Paused when paused", () => {
    expect(botStatusLine(base)).toEqual({ text: "Nothing running", tone: "idle" });
    expect(botStatusLine({ ...base, bot: { paused: true } })).toEqual({
      text: "Paused",
      tone: "paused",
    });
  });

  it.each([
    {
      name: "an open ask outranks pausing",
      paused: true,
      asks: [ask()],
      kinds: [],
      pose: "needs-you",
    },
    { name: "paused outranks working", paused: true, asks: [], kinds: ["working"], pose: "paused" },
    {
      name: "waiting on the bot counts as working",
      paused: false,
      asks: [],
      kinds: ["done", "waiting"],
      pose: "working",
    },
    {
      name: "quiet, paused and taken over sessions stay still",
      paused: false,
      asks: [ask({ status: "answered" })],
      kinds: ["quiet", "paused", "taken-over"],
      pose: "idle",
    },
  ] as const)("poses the face: $name", ({ paused, asks, kinds, pose }) => {
    expect(
      botFacePose({ bot: { paused }, asks, sessionStates: kinds.map((kind) => state({ kind })) }),
    ).toBe(pose);
  });
});

describe("botSessionRows", () => {
  const askedJobId = BotJobIdSchema.make("job:asked");
  const otherJobId = BotJobIdSchema.make("job:other");
  const openAsk = ask({ jobId: askedJobId });

  it("orders needs-you, failed, working, then finished newest first, older ones earlier", () => {
    const sessions = [
      session(otherJobId, { title: "Finished older", createdAt: "2026-11-18T07:00:00.000Z" }),
      session(otherJobId, { title: "Working" }),
      session(otherJobId, { title: "Failed" }),
      session(askedJobId, { title: "Needs you" }),
      session(otherJobId, { title: "Finished newer", createdAt: "2026-11-18T08:00:00.000Z" }),
      session(otherJobId, { title: "Too old" }),
      session(otherJobId, { title: "Stopped" }),
    ];
    const states = [
      state({ kind: "done", updatedAt: "2026-11-18T11:00:00.000Z" }),
      state({ kind: "working" }),
      state({ kind: "failed" }),
      state({ kind: "waiting" }),
      state({ kind: "done", updatedAt: "2026-11-18T11:30:00.000Z" }),
      state({ kind: "done", updatedAt: "2026-11-10T11:00:00.000Z" }),
      state({ kind: "stopped" }),
    ];
    const list = botSessionRows({ sessions, states, jobs: [], asks: [openAsk], nowMs });
    expect(list.rows.map((row) => `${row.session.title}:${row.bucket}`)).toEqual([
      "Needs you:needs-you",
      "Failed:failed",
      "Stopped:failed",
      "Working:working",
      "Finished newer:finished",
      "Finished older:finished",
    ]);
    expect(list.earlier.map((row) => row.session.title)).toEqual(["Too old"]);
  });

  it("does not mark a finished session as needs-you", () => {
    const list = botSessionRows({
      sessions: [session(askedJobId, { title: "Finished" })],
      states: [state({ kind: "done", updatedAt: "2026-11-18T11:00:00.000Z" })],
      jobs: [],
      asks: [openAsk],
      nowMs,
    });
    expect(list.rows.map((row) => row.bucket)).toEqual(["finished"]);
  });

  it("sets an archived job apart unless it has an open question", () => {
    const archivedAt = "2026-11-18T11:00:00.000Z";
    const done = state({ kind: "done", updatedAt: archivedAt });
    const list = botSessionRows({
      sessions: [session(askedJobId, { title: "Asked" }), session(otherJobId, { title: "Gone" })],
      states: [done, done],
      jobs: [
        job({ number: 1, id: askedJobId, status: "done", archivedAt }),
        job({ number: 2, id: otherJobId, status: "done", archivedAt }),
      ],
      asks: [openAsk],
      nowMs,
    });
    expect(list.rows.map((row) => row.session.title)).toEqual(["Asked"]);
    expect(list.archived.map((row) => [row.session.title, row.jobFinished])).toEqual([
      ["Gone", true],
    ]);
  });
});

describe("timeOfDay", () => {
  it("formats the local time and passes an unparsable value through", () => {
    expect(timeOfDay(new Date(2024, 0, 1, 9, 5).toISOString())).toBe("09:05");
    expect(timeOfDay("nonsense")).toBe("nonsense");
  });
});

describe("botSessionShellsKey", () => {
  it.each([
    { environmentId: "env:mac", threadIds: [] },
    { environmentId: "env:mac", threadIds: ["thread:a", "thread:b"] },
    { environmentId: null, threadIds: [] },
  ])("reads back $threadIds.length thread ids", ({ environmentId, threadIds }) => {
    expect(parseBotSessionShellsKey(botSessionShellsKey(environmentId, threadIds))).toEqual({
      environmentId: environmentId ?? "",
      threadIds,
    });
  });
});

describe("botsEnvironmentStatus", () => {
  it.each([
    { phase: "connected", outcome: "success", status: "loaded" },
    { phase: "connected", outcome: "pending", status: "loading" },
    { phase: "connected", outcome: "failure", status: "failed" },
    { phase: "connecting", outcome: "pending", status: "loading" },
    { phase: "reconnecting", outcome: "success", status: "loading" },
    { phase: "reconnecting", outcome: "failure", status: "failed" },
    // A dropped subscription keeps its last value; only the phase says the server is down.
    { phase: "offline", outcome: "success", status: "offline" },
    { phase: "error", outcome: "failure", status: "offline" },
  ] as const)("$phase with $outcome is $status", ({ phase, outcome, status }) => {
    expect(botsEnvironmentStatus(phase, outcome)).toBe(status);
  });

  it.each([
    { result: AsyncResult.success(null), outcome: "success" },
    { result: AsyncResult.initial(true), outcome: "pending" },
    { result: AsyncResult.failure(Cause.fail("down")), outcome: "failure" },
    // A retry tap restarts it: loading, not the same failure again.
    { result: AsyncResult.failure(Cause.fail("down"), { waiting: true }), outcome: "pending" },
  ])("a $outcome snapshot result", ({ result, outcome }) => {
    expect(botsSnapshotOutcome(result)).toBe(outcome);
  });
});

describe("botsScreenModel", () => {
  const mac = EnvironmentId.make("env:mac");
  const cloud = EnvironmentId.make("env:cloud");

  function bot(id: string): Bot {
    return {
      id: BotId.make(id),
      ownerId: "member:1" as Bot["ownerId"],
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
      createdAt: "2026-11-18T09:00:00.000Z",
      updatedAt: "2026-11-18T09:00:00.000Z",
    };
  }

  function snapshot(bots: ReadonlyArray<Bot>): BotsSnapshot {
    return { bots, jobs: [], sessions: [], asks: [], notes: [], events: [], revision: 1 };
  }

  function entry(
    environmentId: EnvironmentId,
    overrides: Partial<BotsEnvironmentEntry> = {},
  ): BotsEnvironmentEntry {
    return {
      environmentId,
      label: environmentId,
      machineKind: "laptop",
      status: "loaded",
      snapshot: snapshot([]),
      canCreate: true,
      canArchive: true,
      ...overrides,
    };
  }

  const summary = (entries: ReadonlyArray<BotsEnvironmentEntry>, catalogReady = true) => {
    const model = botsScreenModel(entries, catalogReady);
    return {
      view: model.view,
      groups: model.groups.map((group) => [
        group.entry.environmentId,
        group.bots.length,
        group.showHeader,
      ]),
      createMode: model.createMode,
    };
  };

  it.each([
    {
      name: "one server with no bots is empty",
      entries: [entry(mac)],
      expected: { view: "empty", groups: [], createMode: "direct" },
    },
    {
      name: "a second server's bots show, named, when the first has none",
      entries: [entry(cloud), entry(mac, { snapshot: snapshot([bot("bot:atlas")]) })],
      expected: { view: "list", groups: [[mac, 1, true]], createMode: "menu" },
    },
    {
      name: "servers still connecting spin",
      entries: [
        entry(mac, { status: "loading", snapshot: null, canCreate: false }),
        entry(cloud, { status: "loading", snapshot: null, canCreate: false }),
      ],
      expected: { view: "spinner", groups: [], createMode: "none" },
    },
    {
      name: "an offline server keeps its bots under a header, and isn't a create target",
      entries: [
        entry(mac, {
          status: "offline",
          snapshot: snapshot([bot("bot:atlas")]),
          canCreate: false,
        }),
        entry(cloud),
      ],
      expected: { view: "list", groups: [[mac, 1, true]], createMode: "menu" },
    },
    {
      name: "a lone failed server says so instead of spinning",
      entries: [entry(mac, { status: "failed", snapshot: null, canCreate: false })],
      expected: { view: "list", groups: [[mac, 0, true]], createMode: "none" },
    },
    {
      name: "a server that failed after loading keeps its bots",
      entries: [
        entry(mac, {
          status: "failed",
          snapshot: snapshot([bot("bot:atlas")]),
          canCreate: false,
        }),
      ],
      expected: { view: "list", groups: [[mac, 1, true]], createMode: "none" },
    },
    {
      name: "a lone server's bots have no header",
      entries: [entry(mac, { snapshot: snapshot([bot("bot:atlas"), bot("bot:nova")]) })],
      expected: { view: "list", groups: [[mac, 2, false]], createMode: "direct" },
    },
    {
      name: "no linked server spins",
      entries: [],
      expected: { view: "spinner", groups: [], createMode: "none" },
    },
  ])("$name", ({ entries, expected }) => {
    expect(summary(entries)).toEqual(expected);
  });

  it("spins until the saved servers are read, instead of offering a first bot", () => {
    expect(summary([entry(mac)], false).view).toBe("spinner");
  });
});
