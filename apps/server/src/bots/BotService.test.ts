import { assert, it } from "@effect/vitest";
import {
  BOT_DEFAULT_INSTRUCTIONS,
  BOT_ESCALATE_AFTER_MS,
  BOT_LIMIT_LABELS,
  BOT_QUIET_AFTER_MS,
  BOT_WAKE_BATCH_MS,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ThreadId,
  MemberId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as BotService from "./BotService.ts";
import * as BotStore from "./BotStore.ts";
import { BotThreads } from "./botThreads.ts";

const rutvik = MemberId.make("member:rutvik");
const kousik = MemberId.make("member:kousik");
const caller: BotService.BotCaller = { memberId: rutvik };
const otherCaller: BotService.BotCaller = { memberId: kousik };

let dispatched: ReadonlyArray<OrchestrationV2ServerCommand> = [];

const threadStub = {
  dispatch: (command: OrchestrationV2ServerCommand) => {
    dispatched = [...dispatched, command];
    return Effect.succeed({ sequence: dispatched.length, storedEvents: [] });
  },
} as unknown as ThreadManagementService.ThreadManagementService["Service"];

const layerTest = BotService.layer({ cloudOnly: false }).pipe(
  Layer.provide(BotStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
  Layer.provide(Layer.succeed(ThreadManagementService.ThreadManagementService, threadStub)),
  Layer.provide(SecureRandom.layerWebCrypto),
);

const layerFor = (cloudOnly: boolean) =>
  BotService.layer({ cloudOnly }).pipe(
    Layer.provide(BotStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    Layer.provide(Layer.succeed(ThreadManagementService.ThreadManagementService, threadStub)),
    Layer.provide(SecureRandom.layerWebCrypto),
  );

const createBot = (service: BotService.BotService["Service"]) =>
  service.create(caller, { name: "Atlas", charter: "Ship it", starter: "default" });

it.effect("creates a Default bot and shows it in the caller's snapshot", () =>
  Effect.gen(function* () {
    const bots = yield* BotService.BotService;
    const bot = yield* createBot(bots);
    assert.strictEqual(bot.instructions, BOT_DEFAULT_INSTRUCTIONS);
    assert.strictEqual(bot.limits.length, 5);
    assert.isFalse(bot.paused);
    assert.strictEqual(bot.nextJobNumber, 1);

    // The watcher constants and limit labels ship with the schema; keep them reachable.
    assert.strictEqual(Object.keys(BOT_LIMIT_LABELS).length, 6);
    assert.isAbove(BOT_ESCALATE_AFTER_MS, 0);
    assert.isAbove(BOT_QUIET_AFTER_MS, BOT_ESCALATE_AFTER_MS);
    assert.isAbove(BOT_WAKE_BATCH_MS, 0);

    const snapshot = yield* bots
      .subscribe(caller)
      .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
    assert.deepStrictEqual(
      snapshot.bots.map((entry) => entry.id),
      [bot.id],
    );
    assert.strictEqual(snapshot.revision, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("gives each new bot an unused name and face, unless the caller picks them", () =>
  Effect.gen(function* () {
    const bots = yield* BotService.BotService;
    const first = yield* bots.create(caller, { charter: "", starter: "default" });
    const second = yield* bots.create(caller, { charter: "", starter: "default" });
    const picked = yield* bots.create(caller, {
      charter: "",
      starter: "default",
      color: "#6366f1",
      shape: "hex",
      voice: "candid",
    });
    assert.deepStrictEqual(
      [first, second, picked].map((bot) => [bot.name, bot.color, bot.shape, bot.voice]),
      [
        ["Atlas", "#6366f1", "round", "crisp"],
        ["Nova", "#0d9488", "square", "crisp"],
        ["Echo", "#6366f1", "hex", "candid"],
      ],
    );
    const edited = yield* bots.update(caller, { botId: first.id, shape: "tall", voice: "candid" });
    assert.deepStrictEqual([edited.shape, edited.voice], ["tall", "candid"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("numbers and titles jobs, and wakes the home thread", () =>
  Effect.gen(function* () {
    const bots = yield* BotService.BotService;
    const wakes = yield* bots.wakes.pipe(Stream.toQueue({ capacity: "unbounded" }));
    // Let the feeder subscribe before the first write can publish.
    yield* Effect.yieldNow;
    const bot = yield* createBot(bots);

    const first = yield* bots.createJob(caller, { botId: bot.id, request: "First job" });
    const second = yield* bots.createJob(caller, { botId: bot.id, request: "Second job" });
    assert.strictEqual(first.number, 1);
    assert.strictEqual(second.number, 2);
    assert.strictEqual(first.title, "First job");

    assert.strictEqual((yield* Queue.take(wakes)).reason, "created");
    const started: BotService.BotWake = yield* Queue.take(wakes);
    assert.strictEqual(started.reason, "job-started");
    assert.include(started.text, 'New job "First job"');
    const secondWake = yield* Queue.take(wakes);
    assert.include(secondWake.text, 'New job "Second job"');
    assert.include(secondWake.text, "Pick the project.");
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("answers an ask with remember and wakes with the bot_learn line", () =>
  Effect.gen(function* () {
    const bots = yield* BotService.BotService;
    const bot = yield* createBot(bots);
    const job = yield* bots.createJob(caller, { botId: bot.id, request: "Answer me" });
    const ask = yield* bots.createAsk(bot.id, {
      jobId: job.id,
      question: "Which colour?",
      why: "The user will notice.",
      options: ["Indigo", "Teal"],
      pick: "Indigo",
    });

    const wakes = yield* bots.wakes.pipe(Stream.toQueue({ capacity: "unbounded" }));
    yield* Effect.yieldNow;
    const answered = yield* bots.answerAsk(caller, {
      askId: ask.id,
      kind: "text",
      answer: "Teal",
      remember: true,
    });
    assert.strictEqual(answered.status, "answered");
    assert.strictEqual(answered.remember, true);

    const wake = yield* Queue.take(wakes);
    assert.include(wake.text, "bot_learn");
    assert.include(wake.text, "Teal");

    // Answering again changes the answer and tells the bot to undo the old one.
    const changed = yield* bots.answerAsk(caller, {
      askId: ask.id,
      kind: "text",
      answer: "Indigo",
      remember: false,
    });
    assert.strictEqual(changed.answer, "Indigo");
    const changeWake = yield* Queue.take(wakes);
    assert.include(changeWake.text, 'from "Teal" to "Indigo"');
    assert.include(changeWake.text, "undo work");

    yield* bots.answerAsk(caller, { askId: ask.id, kind: "bot-decides", remember: false });
    yield* Queue.take(wakes);
    const twice = yield* bots
      .answerAsk(caller, { askId: ask.id, kind: "bot-decides", remember: false })
      .pipe(Effect.flip);
    assert.strictEqual(twice.reason, "invalid-request");
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("stops a job's sessions through thread.stop", () =>
  Effect.gen(function* () {
    const bots = yield* BotService.BotService;
    const bot = yield* createBot(bots);
    const job = yield* bots.createJob(caller, { botId: bot.id, request: "Stop me" });
    const threadId = ThreadId.make("thread:bot-session-1");
    yield* bots.addSession({
      threadId,
      botId: bot.id,
      jobId: job.id,
      role: "worker",
      title: "Stop me",
      projectId: ProjectId.make("project:bots"),
      takenOver: false,
      createdAt: "2026-11-18T00:00:00.000Z",
    });

    dispatched = [];
    const stopped = yield* bots.stopJob(caller, { jobId: job.id });
    assert.strictEqual(stopped.status, "stopped");
    const stops = dispatched.filter((command) => command.type === "thread.stop");
    assert.strictEqual(stops.length, 1);
    assert.strictEqual(stops[0]?.threadId, threadId);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("hides a bot from another member", () =>
  Effect.gen(function* () {
    const bots = yield* BotService.BotService;
    const bot = yield* createBot(bots);
    const hidden = yield* bots
      .createJob(otherCaller, { botId: bot.id, request: "Not yours" })
      .pipe(Effect.flip);
    assert.strictEqual(hidden.reason, "not-found");

    const mine = yield* bots.getBot(bot.id);
    assert.isTrue(Option.isSome(mine));
    const all = yield* bots.listAllBots();
    assert.strictEqual(all.length, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("saves a note from an ask and links it back", () =>
  Effect.gen(function* () {
    const bots = yield* BotService.BotService;
    const bot = yield* createBot(bots);
    const ask = yield* bots.createAsk(bot.id, {
      jobId: null,
      question: "What next?",
      why: "",
      options: [],
      pick: null,
    });
    yield* bots.resolveAsk(bot.id, ask.id, { answerKind: "text", answer: "Ship it" });
    const note = yield* bots.addNote(bot.id, {
      text: "Ship small changes",
      source: "From Chat",
      sourceJobId: null,
      askId: ask.id,
    });

    const snapshot = yield* bots.snapshotForBot(bot.id);
    const stored = snapshot.asks.find((entry) => entry.id === ask.id);
    assert.strictEqual(stored?.noteId, note.id);
    const cited = yield* bots.citeNote(note.id);
    assert.strictEqual(cited.citedCount, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("creates a job for the bot without waking the home thread", () =>
  Effect.gen(function* () {
    const bots = yield* BotService.BotService;
    const bot = yield* createBot(bots);
    const wakes = yield* bots.wakes.pipe(Stream.toQueue({ capacity: "unbounded" }));
    yield* Effect.yieldNow;
    const projectId = ProjectId.make("project:one");
    const job = yield* bots.createJobForBot(bot.id, {
      title: "Sidebar drag flicker",
      request: "Fix the flicker",
      projectId,
    });
    assert.strictEqual(job.title, "Sidebar drag flicker");
    assert.strictEqual(job.request, "Fix the flicker");
    assert.strictEqual(job.projectId, projectId);
    assert.strictEqual(job.number, 1);
    yield* Effect.yieldNow;
    assert.isTrue(Option.isNone(yield* Queue.poll(wakes)));
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("forgets the bot's own note and refuses another bot's", () =>
  Effect.gen(function* () {
    const bots = yield* BotService.BotService;
    const bot = yield* createBot(bots);
    const other = yield* createBot(bots);
    const note = yield* bots.addNote(bot.id, {
      text: "Rate limits are per member",
      source: "From Chat",
      sourceJobId: null,
    });
    const forgotten = yield* bots.forgetNote(bot.id, note.id);
    assert.strictEqual(forgotten.text, "Rate limits are per member");
    assert.strictEqual((yield* bots.snapshotForBot(bot.id)).notes.length, 0);

    const otherNote = yield* bots.addNote(other.id, {
      text: "Their note",
      source: "From Chat",
      sourceJobId: null,
    });
    const failure = yield* bots.forgetNote(bot.id, otherNote.id).pipe(Effect.flip);
    assert.strictEqual(failure.reason, "not-found");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses to reopen a working job", () =>
  Effect.gen(function* () {
    const bots = yield* BotService.BotService;
    const bot = yield* createBot(bots);
    const job = yield* bots.createJob(caller, { botId: bot.id, request: "Still working" });
    const failure = yield* bots.reopenJob(caller, { jobId: job.id }).pipe(Effect.flip);
    assert.strictEqual(failure.reason, "invalid-request");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("tracks home and session threads and finishes a job", () =>
  Effect.gen(function* () {
    BotThreads.reset();
    const bots = yield* BotService.BotService;
    const bot = yield* createBot(bots);
    const homeThreadId = ThreadId.make("thread:bot-home");
    yield* bots.setHome(bot.id, {
      homeThreadId,
      homeProjectId: ProjectId.make("project:bots"),
    });
    assert.isTrue(BotThreads.isBotThread(homeThreadId));
    assert.isTrue(BotThreads.homeBotId(homeThreadId) === bot.id);
    const found = yield* bots.botForHomeThread(homeThreadId);
    assert.isTrue(Option.isSome(found));

    const job = yield* bots.createJob(caller, { botId: bot.id, request: "Finish me" });
    const threadId = ThreadId.make("thread:bot-session-2");
    yield* bots.addSession({
      threadId,
      botId: bot.id,
      jobId: job.id,
      role: "reviewer",
      title: "Finish me",
      projectId: ProjectId.make("project:bots"),
      takenOver: false,
      createdAt: "2026-11-18T00:00:00.000Z",
    });
    assert.isTrue(BotThreads.sessionBotId(threadId) === bot.id);
    const session = yield* bots.sessionForThread(threadId);
    assert.isTrue(Option.isSome(session));
    yield* bots.setSessionTakenOver(threadId, true);
    const taken = yield* bots.sessionForThread(threadId);
    assert.strictEqual(Option.getOrThrow(taken).takenOver, true);

    yield* bots.addEvent({ botId: bot.id, kind: "info", text: "A quiet note" });
    const done = yield* bots.updateJob(bot.id, job.id, {
      headline: "Wrapped up",
      status: "done",
      report: { changed: "It works", evidence: [], openQuestions: [], next: null },
    });
    assert.strictEqual(done.status, "done");
    assert.isNotNull(done.headlineAt);
    const snapshot = yield* bots.snapshotForBot(bot.id);
    assert.isTrue(snapshot.events.some((event) => event.kind === "job-done"));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses to create a bot on a cloud-only server", () =>
  Effect.gen(function* () {
    const bots = yield* BotService.BotService;
    const failure = yield* createBot(bots).pipe(Effect.flip);
    assert.strictEqual(failure.reason, "cloud-only");
  }).pipe(Effect.provide(layerFor(true))),
);
