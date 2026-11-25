import * as NodeServices from "@effect/platform-node/NodeServices";
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
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as BotPictures from "./BotPictures.ts";
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
  Layer.provide(BotPictures.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bot-service-" })),
  Layer.provideMerge(NodeServices.layer),
);

const layerFor = (cloudOnly: boolean) =>
  BotService.layer({ cloudOnly }).pipe(
    Layer.provide(BotStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    Layer.provide(Layer.succeed(ThreadManagementService.ThreadManagementService, threadStub)),
    Layer.provide(SecureRandom.layerWebCrypto),
    Layer.provide(Layer.mock(BotPictures.BotPictures)({})),
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
    yield* TestClock.adjust("1 minute");

    const first = yield* bots.createJob(caller, { botId: bot.id, request: "First job" });
    const second = yield* bots.createJob(caller, { botId: bot.id, request: "Second job" });
    assert.strictEqual(first.number, 1);
    assert.strictEqual(second.number, 2);
    assert.strictEqual(first.title, "First job");
    // A new job reaches the bot's brief as a diff, so the bot itself is not marked changed.
    const afterJobs = (yield* bots.snapshotForBot(bot.id)).bots[0]!;
    assert.strictEqual(afterJobs.nextJobNumber, bot.nextJobNumber + 2);
    assert.strictEqual(afterJobs.updatedAt, bot.updatedAt);

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

it.effect("refuses to change an answer given elsewhere when asked to answer only an open ask", () =>
  Effect.gen(function* () {
    const bots = yield* BotService.BotService;
    const bot = yield* createBot(bots);
    const ask = yield* bots.createAsk(bot.id, {
      jobId: null,
      question: "Ship it?",
      why: "",
      options: ["Yes", "No"],
      pick: null,
    });
    yield* bots.resolveAsk(bot.id, ask.id, { answerKind: "text", answer: "Yes" });

    const failure = yield* bots
      .answerAsk(caller, {
        askId: ask.id,
        kind: "option",
        answer: "No",
        remember: false,
        ifOpen: true,
      })
      .pipe(Effect.flip);
    assert.strictEqual(failure.reason, "already-answered");
    const after = (yield* bots.snapshotForBot(bot.id)).asks.find(
      (candidate) => candidate.id === ask.id,
    );
    assert.strictEqual(after?.answer, "Yes");
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
    yield* TestClock.adjust("1 minute");
    const cited = yield* bots.citeNote(note.id);
    assert.strictEqual(cited.citedCount, 1);
    // A citation is not an edit: the next diff must not resend the note.
    assert.strictEqual(cited.updatedAt, note.updatedAt);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps one note per rule, linking a repeat's Ask to the note it already had", () =>
  Effect.gen(function* () {
    const bots = yield* BotService.BotService;
    const bot = yield* createBot(bots);
    const input = { source: "From Chat", sourceJobId: null };
    const first = yield* bots.addNote(bot.id, { ...input, text: "Ship small changes" });
    const ask = yield* bots.createAsk(bot.id, {
      jobId: null,
      question: "Big PRs?",
      why: "",
      options: [],
      pick: null,
    });
    const repeat = yield* bots.addNote(bot.id, {
      ...input,
      text: "  ship SMALL\nchanges ",
      askId: ask.id,
    });
    const other = yield* bots.addNote(bot.id, { ...input, text: "Ship big changes" });

    assert.strictEqual(repeat.id, first.id);
    assert.notStrictEqual(other.id, first.id);
    const snapshot = yield* bots.snapshotForBot(bot.id);
    assert.strictEqual(snapshot.notes.length, 2);
    assert.strictEqual(snapshot.asks.find((entry) => entry.id === ask.id)?.noteId, first.id);
    assert.strictEqual(snapshot.events.filter((event) => event.kind === "note-saved").length, 2);
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

it.effect(
  "forgets the bot's own note, refuses another bot's, and marks the bot when the user deletes one",
  () =>
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

      // The user's delete changes the bot, so its next brief comes whole and drops the note.
      const userNote = yield* bots.addNote(bot.id, {
        text: "Deploy on Fridays",
        source: "From Chat",
        sourceJobId: null,
      });
      yield* TestClock.adjust("1 minute");
      yield* bots.deleteNote(caller, { noteId: userNote.id });
      const changed = (yield* bots.snapshotForBot(bot.id)).bots[0]!;
      assert.isAbove(Date.parse(changed.updatedAt), Date.parse(bot.updatedAt));
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

it.effect("archives only a finished job, and reopening brings it back", () =>
  Effect.gen(function* () {
    const bots = yield* BotService.BotService;
    const bot = yield* createBot(bots);
    const job = yield* bots.createJob(caller, { botId: bot.id, request: "Archive me" });
    const working = yield* bots
      .archiveJob(caller, { jobId: job.id, archived: true })
      .pipe(Effect.flip);
    assert.strictEqual(working.reason, "invalid-request");

    const report = { changed: "Done", evidence: [], openQuestions: [], next: null };
    const archived = yield* bots.updateJob(bot.id, job.id, {
      status: "done",
      report,
      archived: true,
    });
    assert.isNotNull(archived.archivedAt);
    const restored = yield* bots.archiveJob(caller, { jobId: job.id, archived: false });
    assert.isNull(restored.archivedAt);

    yield* bots.archiveJob(caller, { jobId: job.id, archived: true });
    const reopened = yield* bots.reopenJob(caller, { jobId: job.id });
    assert.isNull(reopened.archivedAt);

    yield* bots.updateJob(bot.id, job.id, { status: "done", report, archived: true });
    const reopenedByBot = yield* bots.updateJob(bot.id, job.id, { status: "working" });
    assert.strictEqual(reopenedByBot.status, "working");
    assert.isNull(reopenedByBot.finishedAt);
    assert.isNull(reopenedByBot.archivedAt);
    assert.deepStrictEqual(reopenedByBot.report, report);
    const noop = yield* bots.updateJob(bot.id, job.id, { status: "working" });
    assert.strictEqual(noop.status, "working");
    yield* bots.stopJob(caller, { jobId: job.id });
    const stopped = yield* bots.updateJob(bot.id, job.id, { status: "working" }).pipe(Effect.flip);
    assert.strictEqual(stopped.reason, "invalid-request");
    const hidden = yield* bots
      .archiveJob(otherCaller, { jobId: job.id, archived: true })
      .pipe(Effect.flip);
    assert.strictEqual(hidden.reason, "not-found");
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
    yield* bots.setSessionTakenOver(threadId, false);
    yield* bots.setSessionTakenOver(threadId, false);
    const handedBack = yield* bots.sessionForThread(threadId);
    assert.strictEqual(Option.getOrThrow(handedBack).takenOver, false);
    yield* bots.setSessionTakenOver(threadId, true);

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
    assert.strictEqual(
      snapshot.events.filter((event) => event.kind === "session-handed-back").length,
      1,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses to create a bot on a cloud-only server", () =>
  Effect.gen(function* () {
    const bots = yield* BotService.BotService;
    const failure = yield* createBot(bots).pipe(Effect.flip);
    assert.strictEqual(failure.reason, "cloud-only");
  }).pipe(Effect.provide(layerFor(true))),
);

it.effect(
  "adopts an uploaded picture, deletes the one it replaces, and goes back to the face",
  () =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const random = yield* SecureRandom.SecureRandom;
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      const pendingId = Effect.map(random.uuidV4(), (uuid) => `pending-${uuid}`);
      const upload = Effect.fnUntraced(function* (extension: string) {
        const id = yield* pendingId;
        yield* fileSystem.writeFileString(path.join(attachmentsDir, `${id}${extension}`), "image");
        return id;
      });
      const stored = (attachmentId: string) =>
        Effect.map(fileSystem.readDirectory(attachmentsDir), (entries) =>
          entries.some((entry) => entry.startsWith(`${attachmentId}.`)),
        );
      const bot = yield* createBot(bots);
      assert.isNull(bot.picture);

      const gifUpload = yield* upload(".gif");
      const withGif = yield* bots.update(caller, {
        botId: bot.id,
        picture: { attachmentId: gifUpload },
      });
      assert.strictEqual(withGif.picture?.mimeType, "image/gif");
      assert.isFalse(yield* stored(gifUpload));
      assert.isTrue(yield* stored(withGif.picture!.attachmentId));

      const withPng = yield* bots.update(caller, {
        botId: bot.id,
        picture: { attachmentId: yield* upload(".png") },
      });
      assert.strictEqual(withPng.picture?.mimeType, "image/png");
      assert.isFalse(yield* stored(withGif.picture!.attachmentId));

      const renamed = yield* bots.update(caller, { botId: bot.id, name: "Nova" });
      assert.deepStrictEqual(renamed.picture, withPng.picture);

      const face = yield* bots.update(caller, { botId: bot.id, picture: null });
      assert.isNull(face.picture);
      assert.isFalse(yield* stored(withPng.picture!.attachmentId));

      const missing = yield* bots
        .update(caller, { botId: bot.id, picture: { attachmentId: yield* pendingId } })
        .pipe(Effect.flip);
      assert.strictEqual(missing.reason, "invalid-request");
    }).pipe(Effect.provide(Layer.merge(layerTest, SecureRandom.layerWebCrypto))),
);
