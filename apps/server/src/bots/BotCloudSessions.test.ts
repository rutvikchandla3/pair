import { assert, describe, it } from "@effect/vitest";
import {
  type Bot,
  type BotAsk,
  BotAskId,
  type BotCloudSession,
  BotId,
  type BotJob,
  BotJobId,
  type BotSession,
  EnvironmentId,
  MemberId,
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadReadResult,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as BotCloudSessions from "./BotCloudSessions.ts";
import { type BotWake, BotService } from "./BotService.ts";

const at = "2026-11-19T00:00:00.000Z";
const model = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-5-5" };
const cloudId = EnvironmentId.make("env:cloud");
const threadId = ThreadId.make("thread:cloud-session");
const runId = RunId.make("run:1");
const requestId = RuntimeRequestId.make("request:1");

const bot: Bot = {
  id: BotId.make("bot:atlas"),
  ownerId: MemberId.make("member:owner"),
  name: "Atlas",
  color: "#6366f1",
  shape: "round",
  voice: "crisp",
  picture: null,
  charter: "",
  instructions: "",
  limits: [],
  models: { brain: model, worker: model, reviewer: model },
  homeThreadId: ThreadId.make("thread:home"),
  homeProjectId: null,
  paused: false,
  lastSeenAt: null,
  nextJobNumber: 2,
  createdAt: at,
  updatedAt: at,
};

const job = (status: BotJob["status"] = "working"): BotJob => ({
  id: BotJobId.make("job:1"),
  botId: bot.id,
  number: 1,
  title: "Rate limit",
  request: "rate-limit the threads API",
  projectId: ProjectId.make("project:repo"),
  status,
  headline: "",
  headlineAt: null,
  pullRequests: [],
  report: null,
  createdAt: at,
  updatedAt: at,
  finishedAt: null,
  archivedAt: null,
});

const cloud: BotCloudSession = {
  environmentId: cloudId,
  label: "Pair Cloud",
  state: "working",
  pendingRequest: null,
  lastOutputAt: at,
  reportedRunId: null,
  reportedRequestIds: [],
  position: 0,
};

const session: BotSession = {
  threadId,
  botId: bot.id,
  jobId: BotJobId.make("job:1"),
  role: "worker",
  title: "Rate limit",
  projectId: ProjectId.make("project:there"),
  takenOver: false,
  createdAt: at,
  cloud,
};

/** What the thread there reads as: its run, pending questions and new timeline items. */
interface There {
  status: string;
  runStatus: string | null;
  pendingRequestIds: ReadonlyArray<RuntimeRequestId>;
  pendingRequestCount?: number;
  archived?: boolean;
  items: ReadonlyArray<{ type: string; createdBy: "user" | "agent"; text?: string }>;
  error?: OrchestratorMcpFailure;
}

const readResult = (there: There): OrchestratorMcpThreadReadResult =>
  ({
    thread: {
      threadId,
      status: there.status,
      archived: there.archived ?? false,
      pendingRequestCount: there.pendingRequestCount ?? there.pendingRequestIds.length,
      latestRunId: runId,
      updatedAt: at,
      pullRequests: [],
    },
    recentRuns: there.runStatus === null ? [] : [{ runId, ordinal: 1, status: there.runStatus }],
    items: there.items.map((item, index) => ({
      position: index + 1,
      type: item.type,
      createdBy: item.createdBy,
      runId,
      text: item.text ?? null,
    })),
    nextPosition: null,
    hasMore: false,
  }) as never;

/** A follower over an in-memory bot and a scripted cloud. */
const harness = (options: { readonly job?: BotJob; readonly linkGone?: boolean } = {}) => {
  const state = {
    sessions: new Map<ThreadId, BotSession>([[threadId, session]]),
    jobs: [options.job ?? job()],
    asks: [] as Array<BotAsk>,
    wakes: [] as Array<BotWake>,
    events: [] as Array<string>,
    interrupts: 0,
    there: { status: "running", runStatus: "running", pendingRequestIds: [], items: [] } as There,
  };
  const layer = BotCloudSessions.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(BotService)({
          listAllBots: () => Effect.succeed([bot]),
          listSessions: () => Effect.sync(() => [...state.sessions.values()]),
          listJobs: () => Effect.sync(() => state.jobs),
          listAsks: () => Effect.sync(() => state.asks),
          getJob: () => Effect.sync(() => Option.fromNullishOr(state.jobs[0])),
          updateJob: () => Effect.sync(() => state.jobs[0]!),
          setSessionCloud: (id, next) =>
            Effect.sync(() => {
              const updated = { ...state.sessions.get(id)!, cloud: next };
              state.sessions.set(id, updated);
              return updated;
            }),
          setSessionTakenOver: (id, takenOver) =>
            Effect.sync(() => {
              const updated = { ...state.sessions.get(id)!, takenOver };
              state.sessions.set(id, updated);
              return updated;
            }),
          addEvent: (input) =>
            Effect.sync(() => {
              state.events.push(input.text);
              return {} as never;
            }),
          publishWake: (wake) => Effect.sync(() => void state.wakes.push(wake)),
          createAsk: (_botId, input) =>
            Effect.sync(() => {
              const ask: BotAsk = {
                id: BotAskId.make(`ask:${state.asks.length + 1}`),
                botId: bot.id,
                jobId: input.jobId,
                question: input.question,
                why: input.why,
                options: input.options,
                pick: input.pick,
                status: "open",
                answerKind: null,
                answer: null,
                remember: false,
                noteId: null,
                homeRunId: null,
                createdAt: at,
                answeredAt: null,
              };
              state.asks.push(ask);
              return ask;
            }),
          resolveAsk: (_botId, askId, input) =>
            Effect.sync(() => {
              const index = state.asks.findIndex((ask) => ask.id === askId);
              const resolved: BotAsk = {
                ...state.asks[index]!,
                status: "answered",
                answerKind: input.answerKind,
                answer: input.answer,
              };
              state.asks[index] = resolved;
              return resolved;
            }),
        }),
        Layer.mock(PeerForwarding.PeerForwarding)({
          readThread: (_scope, _environmentId, input) =>
            state.there.error !== undefined
              ? Effect.fail(state.there.error)
              : Effect.succeed(
                  input.view === "activity"
                    ? ({
                        ...readResult(state.there),
                        items: [{ type: "error", runId, text: "machine failed to start" }],
                      } as never)
                    : readResult(state.there),
                ),
          call: (_scope, _tool, _environmentId, params) => {
            const { action } = params as { action: string };
            return Effect.succeed(
              (action === "list"
                ? { requestIds: state.there.pendingRequestIds }
                : {
                    requestId,
                    questions: [{ question: "Per member or per token?" }],
                  }) as never,
            );
          },
          interruptThread: () =>
            Effect.sync(() => {
              state.interrupts += 1;
              return {} as never;
            }),
        }),
        Layer.mock(PeerLinks.PeerLinks)({
          get: () =>
            Effect.succeed(options.linkGone === true ? Option.none() : Option.some({} as never)),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () =>
            Effect.succeed({
              id: bot.homeThreadId,
              providerInstanceId: model.instanceId,
              activeRunId: null,
            } as never),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("env:here")),
        }),
      ),
    ),
  );
  /** One sweep after the slowest re-check interval, so every session is due. */
  const sweep = Effect.gen(function* () {
    yield* TestClock.adjust(BotCloudSessions.CLOUD_SETTLED_EVERY_MS);
    const follower = yield* BotCloudSessions.BotCloudSessions;
    yield* follower.sweep();
  });
  const current = () => state.sessions.get(threadId)!;
  const reasons = () => state.wakes.map((wake) => wake.reason);
  return { state, layer, sweep, current, reasons };
};

describe("BotCloudSessions", () => {
  it.effect("wakes the bot once when a cloud session finishes, naming where to read it", () => {
    const { state, layer, sweep, current, reasons } = harness();
    return Effect.gen(function* () {
      yield* sweep;
      assert.deepStrictEqual(reasons(), []);
      state.there = { ...state.there, status: "completed", runStatus: "completed" };
      yield* sweep;
      yield* sweep;
      assert.deepStrictEqual(reasons(), ["session-finished"]);
      assert.include(state.wakes[0]!.text, `pass environmentId ${cloudId} to t3_thread_read`);
      assert.strictEqual(current().cloud?.state, "done");
      assert.strictEqual(current().cloud?.reportedRunId, runId);
    }).pipe(Effect.provide(layer));
  });

  it.effect("an archived session there keeps its finished state, marked archived", () => {
    const { state, layer, sweep, current } = harness();
    state.there = { ...state.there, status: "completed", runStatus: "completed", archived: true };
    return Effect.gen(function* () {
      yield* sweep;
      assert.strictEqual(current().cloud?.state, "done");
      assert.strictEqual(current().cloud?.archived, true);
      state.there = { ...state.there, archived: false };
      yield* sweep;
      assert.strictEqual(current().cloud?.archived, undefined);
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes on a failed run's error, such as a machine that would not start", () => {
    const { state, layer, sweep, reasons } = harness();
    state.there = { ...state.there, status: "failed", runStatus: "failed" };
    return Effect.gen(function* () {
      yield* sweep;
      assert.deepStrictEqual(reasons(), ["session-failed"]);
      assert.include(state.wakes[0]!.text, "machine failed to start");
    }).pipe(Effect.provide(layer));
  });

  it.effect("wakes the bot once per question, and once per approval it can't give", () => {
    const { state, layer, sweep, current, reasons } = harness();
    state.there = { ...state.there, pendingRequestIds: [requestId], pendingRequestCount: 2 };
    return Effect.gen(function* () {
      yield* sweep;
      yield* sweep;
      assert.deepStrictEqual(reasons(), ["session-request", "session-request"]);
      assert.include(state.wakes[0]!.text, "Per member or per token?");
      assert.include(state.wakes[1]!.text, "can't be approved from here");
      assert.strictEqual(current().cloud?.state, "waiting");
      assert.strictEqual(current().cloud?.pendingRequest?.requestId, requestId);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads only the user's own message as taking over, never the bot's", () => {
    const { state, layer, sweep, current, reasons } = harness();
    state.there = { ...state.there, items: [{ type: "user_message", createdBy: "agent" }] };
    return Effect.gen(function* () {
      yield* sweep;
      assert.isFalse(current().takenOver);
      state.there = {
        ...state.there,
        items: [
          { type: "user_message", createdBy: "agent" },
          { type: "user_message", createdBy: "user" },
        ],
      };
      yield* sweep;
      assert.isTrue(current().takenOver);
      assert.deepStrictEqual(reasons(), ["session-taken-over"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("announces an outage once after three minutes, then clears it on recovery", () => {
    const { state, layer, sweep, current, reasons } = harness();
    state.there = {
      ...state.there,
      error: new OrchestratorMcpFailure({ code: "orchestration_error", message: "fetch failed" }),
    };
    return Effect.gen(function* () {
      yield* sweep;
      assert.deepStrictEqual(reasons(), []);
      yield* TestClock.adjust(BotCloudSessions.CLOUD_UNREACHABLE_AFTER_MS);
      yield* sweep;
      yield* sweep;
      assert.deepStrictEqual(reasons(), ["cloud-unreachable"]);
      assert.strictEqual(current().cloud?.state, "unreachable");
      assert.lengthOf(state.asks, 1);
      assert.strictEqual(state.asks[0]!.question, "Can't reach Pair Cloud.");
      assert.deepStrictEqual(state.asks[0]!.options, [BotCloudSessions.STOP_FOLLOWING]);
      const { error: _cut, ...reachable } = state.there;
      state.there = reachable;
      yield* sweep;
      assert.strictEqual(current().cloud?.state, "working");
      assert.strictEqual(state.asks[0]!.status, "answered");
      assert.include(state.events, "Pair Cloud is reachable again");
    }).pipe(Effect.provide(layer));
  });

  it.effect("announces an expired or forgotten link at once", () => {
    const expired = harness();
    expired.state.there = {
      ...expired.state.there,
      error: new OrchestratorMcpFailure({ code: "capability_denied", message: "Link expired." }),
    };
    const forgotten = harness({ linkGone: true });
    forgotten.state.there = {
      ...forgotten.state.there,
      error: new OrchestratorMcpFailure({ code: "invalid_request", message: "Unknown link." }),
    };
    return Effect.gen(function* () {
      for (const { layer, sweep, reasons } of [expired, forgotten]) {
        yield* sweep.pipe(Effect.provide(layer));
        assert.deepStrictEqual(reasons(), ["cloud-unreachable"]);
      }
    });
  });

  it.effect("stops following a session whose thread is gone there, without an outage", () => {
    const { state, layer, sweep, current, reasons } = harness();
    state.there = {
      ...state.there,
      error: new OrchestratorMcpFailure({ code: "thread_not_found", message: "Not found." }),
    };
    return Effect.gen(function* () {
      yield* sweep;
      yield* TestClock.adjust(BotCloudSessions.CLOUD_UNREACHABLE_AFTER_MS);
      yield* sweep;
      assert.strictEqual(current().cloud?.state, "stopped");
      assert.isTrue(current().cloud?.unfollowed);
      assert.deepStrictEqual(reasons(), []);
      assert.lengthOf(state.asks, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("stops following an unreachable cloud's sessions when the user says so", () => {
    const { state, layer, sweep, current } = harness();
    state.sessions.set(threadId, { ...session, cloud: { ...cloud, state: "unreachable" } });
    state.asks.push({
      id: BotAskId.make("ask:outage"),
      botId: bot.id,
      jobId: null,
      question: "Can't reach Pair Cloud.",
      why: "",
      options: [BotCloudSessions.STOP_FOLLOWING],
      pick: null,
      status: "answered",
      answerKind: "option",
      answer: BotCloudSessions.STOP_FOLLOWING,
      remember: false,
      noteId: null,
      homeRunId: null,
      createdAt: at,
      answeredAt: at,
    });
    return Effect.gen(function* () {
      yield* sweep;
      assert.strictEqual(current().cloud?.state, "stopped");
      assert.isTrue(current().cloud?.unfollowed);
    }).pipe(Effect.provide(layer));
  });

  it.effect("sends a stopped job's stop to the cloud once", () => {
    const { state, layer, sweep, current } = harness({ job: job("stopped") });
    return Effect.gen(function* () {
      yield* sweep;
      yield* sweep;
      assert.strictEqual(state.interrupts, 1);
      assert.isTrue(current().cloud?.stoppedThere);
      assert.strictEqual(current().cloud?.state, "stopped");
    }).pipe(Effect.provide(layer));
  });
});
