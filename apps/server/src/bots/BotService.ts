import {
  BOT_DEFAULT_INSTRUCTIONS,
  BOT_DEFAULT_LIMITS,
  BOT_EVENTS_PER_BOT,
  Bot,
  BotAsk,
  type BotAskId,
  BotAskId as BotAskIdValue,
  type BotAnswerKind,
  BotDecision,
  BotEvent,
  BotEventId as BotEventIdValue,
  type BotEventKind,
  type BotId,
  BotId as BotIdValue,
  BotJob,
  type BotJobId,
  BotJobId as BotJobIdValue,
  type BotJobReport,
  type BotJobStatus,
  type BotLimit,
  BotNote,
  type BotNoteId,
  BotNoteId as BotNoteIdValue,
  botJobFinished,
  BotSession,
  BotsError,
  type BotsAnswerAskInput,
  type BotsArchiveJobInput,
  type BotsAskInput,
  type BotsBotInput,
  type BotsCorrectDecisionInput,
  type BotsCreateInput,
  type BotsCreateJobInput,
  type BotsJobInput,
  type BotsNoteInput,
  type BotsSessionInput,
  type BotsSnapshot,
  type BotsUpdateInput,
  type BotsUpdateNoteInput,
  CommandId,
  type MemberId,
  type ModelSelection,
  nextBotFace,
  nextBotName,
  type ProjectId,
  ProviderInstanceId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type { BotRepositoryError } from "../persistence/Errors.ts";
import { BotPictures } from "./BotPictures.ts";
import { BotStore } from "./BotStore.ts";
import { BotThreads } from "./botThreads.ts";

/** Who is asking. A bot is visible only to its owner. */
export interface BotCaller {
  readonly memberId: MemberId;
}

/** A wake the bot's home thread should hear. The later watcher batches and says them. */
export interface BotWake {
  readonly botId: BotId;
  readonly reason: string;
  /** The short line the home thread shows as that turn's fold label. */
  readonly label: string;
  readonly text: string;
  /** What only the bot reads, never the chat's fold: a finished session's report. */
  readonly report?: string;
}

const BRAIN_MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "high" }],
};
const WORKER_MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("pi"),
  model: "hackerrank/deepseek-v4.1-flash",
};

const notFound = (message: string) => new BotsError({ reason: "not-found", message });
const invalidRequest = (message: string) => new BotsError({ reason: "invalid-request", message });
/** A note's longest text from the bot: one short rule, as long as the brief shows it whole. */
export const NOTE_MAX_CHARS = 300;
/** Past this many notes the bot is told to merge; a save is never refused for count. */
export const NOTE_SOFT_LIMIT = 200;

/** Two notes are the same rule when they differ only in case and spacing. */
const noteKey = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

/** The job's `archivedAt` after an archive request; only a finished job can be archived. */
const archivedAtFor = (job: BotJob, archived: boolean | undefined, at: string) => {
  if (archived === undefined) return Effect.succeed(job.archivedAt);
  if (!archived) return Effect.succeed(null);
  if (!botJobFinished(job))
    return Effect.fail(invalidRequest("Only a finished job can be archived."));
  return Effect.succeed(job.archivedAt ?? at);
};
const unavailable = (message: string) => new BotsError({ reason: "unavailable", message });

const newBotId = (random: SecureRandom.SecureRandom["Service"]) =>
  random.uuidV4().pipe(Effect.map((value) => BotIdValue.make(`bot:${value}`)));
const newJobId = (random: SecureRandom.SecureRandom["Service"]) =>
  random.uuidV4().pipe(Effect.map((value) => BotJobIdValue.make(`job:${value}`)));
const newAskId = (random: SecureRandom.SecureRandom["Service"]) =>
  random.uuidV4().pipe(Effect.map((value) => BotAskIdValue.make(`ask:${value}`)));
const newNoteId = (random: SecureRandom.SecureRandom["Service"]) =>
  random.uuidV4().pipe(Effect.map((value) => BotNoteIdValue.make(`note:${value}`)));
const newEventId = (random: SecureRandom.SecureRandom["Service"]) =>
  random.uuidV4().pipe(Effect.map((value) => BotEventIdValue.make(`event:${value}`)));
const newCommandId = (random: SecureRandom.SecureRandom["Service"]) =>
  random.uuidV4().pipe(Effect.map((value) => CommandId.make(`bots:${value}`)));

/** Order-sensitive equality, so an unchanged limit array does not look like a playbook change. */
const sameLimits = (left: ReadonlyArray<BotLimit>, right: ReadonlyArray<BotLimit>) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/**
 * Bots: their jobs, sessions, asks, notes, timeline and the snapshot the client reads. Writes run
 * one at a time; each publishes a wake for the bot's home thread and bumps the snapshot revision.
 */
export class BotService extends Context.Service<
  BotService,
  {
    readonly subscribe: (caller: BotCaller) => Stream.Stream<BotsSnapshot, BotsError>;
    readonly create: (caller: BotCaller, input: BotsCreateInput) => Effect.Effect<Bot, BotsError>;
    readonly update: (caller: BotCaller, input: BotsUpdateInput) => Effect.Effect<Bot, BotsError>;
    readonly pause: (caller: BotCaller, input: BotsBotInput) => Effect.Effect<Bot, BotsError>;
    readonly resume: (caller: BotCaller, input: BotsBotInput) => Effect.Effect<Bot, BotsError>;
    readonly delete: (
      caller: BotCaller,
      input: BotsBotInput,
    ) => Effect.Effect<Record<string, never>, BotsError>;
    readonly markSeen: (
      caller: BotCaller,
      input: BotsBotInput,
    ) => Effect.Effect<Record<string, never>, BotsError>;
    readonly createJob: (
      caller: BotCaller,
      input: BotsCreateJobInput,
    ) => Effect.Effect<BotJob, BotsError>;
    /** The bot's own `bot_job_create`: no wake, since the bot made it inside its own turn. */
    readonly createJobForBot: (
      botId: BotId,
      input: {
        readonly title: BotJob["title"];
        readonly request: string;
        readonly projectId?: ProjectId;
      },
    ) => Effect.Effect<BotJob, BotsError>;
    readonly stopJob: (caller: BotCaller, input: BotsJobInput) => Effect.Effect<BotJob, BotsError>;
    readonly reopenJob: (
      caller: BotCaller,
      input: BotsJobInput,
    ) => Effect.Effect<BotJob, BotsError>;
    readonly archiveJob: (
      caller: BotCaller,
      input: BotsArchiveJobInput,
    ) => Effect.Effect<BotJob, BotsError>;
    readonly answerAsk: (
      caller: BotCaller,
      input: BotsAnswerAskInput,
    ) => Effect.Effect<BotAsk, BotsError>;
    readonly rememberAsk: (
      caller: BotCaller,
      input: BotsAskInput,
    ) => Effect.Effect<BotAsk, BotsError>;
    readonly correctDecision: (
      caller: BotCaller,
      input: BotsCorrectDecisionInput,
    ) => Effect.Effect<BotEvent, BotsError>;
    readonly handBackSession: (
      caller: BotCaller,
      input: BotsSessionInput,
    ) => Effect.Effect<BotSession, BotsError>;
    readonly updateNote: (
      caller: BotCaller,
      input: BotsUpdateNoteInput,
    ) => Effect.Effect<BotNote, BotsError>;
    readonly deleteNote: (
      caller: BotCaller,
      input: BotsNoteInput,
    ) => Effect.Effect<Record<string, never>, BotsError>;
    /** The bot's own `bot_forget`: throws away a note it saved, returning the deleted text. */
    readonly forgetNote: (botId: BotId, noteId: BotNoteId) => Effect.Effect<BotNote, BotsError>;

    readonly wakes: Stream.Stream<BotWake>;
    /** Publish a wake for a bot's home thread (the watcher's session events). */
    readonly publishWake: (wake: BotWake) => Effect.Effect<void>;
    /** The owner's member id after every write, so Inbox can refresh bot items. */
    readonly changes: Stream.Stream<MemberId>;
    readonly getBot: (botId: BotId) => Effect.Effect<Option.Option<Bot>, BotsError>;
    readonly listAllBots: () => Effect.Effect<ReadonlyArray<Bot>, BotsError>;
    readonly botForHomeThread: (threadId: ThreadId) => Effect.Effect<Option.Option<Bot>, BotsError>;
    readonly sessionForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<BotSession>, BotsError>;
    readonly snapshotForBot: (botId: BotId) => Effect.Effect<BotsSnapshot, BotsError>;
    readonly getJob: (jobId: BotJobId) => Effect.Effect<Option.Option<BotJob>, BotsError>;
    readonly listJobs: (botId: BotId) => Effect.Effect<ReadonlyArray<BotJob>, BotsError>;
    readonly listSessions: (botId: BotId) => Effect.Effect<ReadonlyArray<BotSession>, BotsError>;
    readonly listAsks: (botId: BotId) => Effect.Effect<ReadonlyArray<BotAsk>, BotsError>;
    readonly setHome: (
      botId: BotId,
      input: { readonly homeThreadId: ThreadId; readonly homeProjectId: Bot["homeProjectId"] },
    ) => Effect.Effect<Bot, BotsError>;
    readonly updateJob: (
      botId: BotId,
      jobId: BotJobId,
      patch: {
        readonly title?: BotJob["title"];
        readonly headline?: string;
        readonly status?: BotJobStatus;
        readonly report?: BotJobReport | null;
        readonly pullRequests?: BotJob["pullRequests"];
        readonly archived?: boolean;
      },
    ) => Effect.Effect<BotJob, BotsError>;
    readonly addSession: (session: BotSession) => Effect.Effect<BotSession, BotsError>;
    /** A cloud session's last-read state; no timeline event. */
    readonly setSessionCloud: (
      threadId: ThreadId,
      cloud: NonNullable<BotSession["cloud"]>,
    ) => Effect.Effect<BotSession, BotsError>;
    readonly setSessionTakenOver: (
      threadId: ThreadId,
      takenOver: boolean,
    ) => Effect.Effect<BotSession, BotsError>;
    /** A local session's `archived`; undefined clears it. No timeline event. */
    readonly setSessionArchived: (
      threadId: ThreadId,
      archived: BotSession["archived"],
    ) => Effect.Effect<BotSession, BotsError>;
    readonly addEvent: (input: {
      readonly botId: BotId;
      readonly jobId?: BotJobId | null;
      readonly kind: BotEventKind;
      readonly text: string;
      readonly sessionThreadId?: ThreadId | null;
      readonly decision?: BotDecision | null;
    }) => Effect.Effect<BotEvent, BotsError>;
    readonly createAsk: (
      botId: BotId,
      input: {
        readonly jobId: BotJobId | null;
        readonly question: string;
        readonly why: string;
        readonly options: ReadonlyArray<string>;
        readonly pick: string | null;
        readonly homeRunId?: RunId | null;
      },
    ) => Effect.Effect<BotAsk, BotsError>;
    readonly resolveAsk: (
      botId: BotId,
      askId: BotAskId,
      input: {
        readonly answerKind: BotAnswerKind;
        readonly answer: string | null;
        /** The timeline line, when Pair itself resolved it rather than the user in Chat. */
        readonly eventText?: string;
      },
    ) => Effect.Effect<BotAsk, BotsError>;
    readonly addNote: (
      botId: BotId,
      input: {
        readonly text: string;
        readonly source: string;
        readonly sourceJobId: BotJobId | null;
        readonly askId?: BotAskId;
      },
    ) => Effect.Effect<BotNote, BotsError>;
    readonly citeNote: (noteId: BotNoteId) => Effect.Effect<BotNote, BotsError>;
  }
>()("t3/bots/BotService") {}

const make = Effect.fn("BotService.make")(function* (options: { readonly cloudOnly: boolean }) {
  const store = yield* BotStore;
  const pictures = yield* BotPictures;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const random = yield* SecureRandom.SecureRandom;
  const revision = yield* Ref.make(0);
  const ownerWrites = yield* PubSub.unbounded<MemberId>();
  const wakePubSub = yield* PubSub.unbounded<BotWake>();
  const semaphore = yield* Semaphore.make(1);

  /** Every store call, mapped to the service's one error type. */
  const db = <A>(effect: Effect.Effect<A, BotRepositoryError>) =>
    effect.pipe(Effect.mapError((error) => unavailable(error.message)));
  const withLock = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    semaphore.withPermits(1)(effect);
  const touch = Effect.fnUntraced(function* (ownerId: MemberId) {
    yield* Ref.update(revision, (value) => value + 1);
    yield* PubSub.publish(ownerWrites, ownerId);
  });
  const wake = (value: BotWake) => PubSub.publish(wakePubSub, value).pipe(Effect.asVoid);

  const requireBot = Effect.fnUntraced(function* (caller: BotCaller, id: BotId) {
    const found = Option.getOrNull(yield* db(store.getBot(id)));
    if (found === null || found.ownerId !== caller.memberId) {
      return yield* notFound("That bot is gone.");
    }
    return found;
  });
  const loadBot = Effect.fnUntraced(function* (id: BotId) {
    const found = Option.getOrNull(yield* db(store.getBot(id)));
    if (found === null) return yield* notFound("That bot is gone.");
    return found;
  });

  const stopThread = Effect.fnUntraced(function* (threadId: ThreadId, reason: string) {
    yield* threadManagement
      .dispatch({
        type: "thread.stop",
        commandId: yield* newCommandId(random),
        threadId,
        stopDelegatedTasks: false,
        reason,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("BotService: failed to stop a thread", {
            threadId,
            reason,
            cause,
          }),
        ),
      );
  });

  /** Newest first, at most `BOT_EVENTS_PER_BOT` per bot. */
  const snapshotOf = Effect.fn("BotService.snapshotOf")(function* (bots: ReadonlyArray<Bot>) {
    const jobs: Array<BotJob> = [];
    const sessions: Array<BotSession> = [];
    const asks: Array<BotAsk> = [];
    const notes: Array<BotNote> = [];
    const events: Array<BotEvent> = [];
    for (const bot of bots) {
      jobs.push(...(yield* db(store.listJobs(bot.id))));
      sessions.push(...(yield* db(store.listSessions(bot.id))));
      asks.push(...(yield* db(store.listAsks(bot.id))));
      notes.push(...(yield* db(store.listNotes(bot.id))));
      events.push(...(yield* db(store.listEvents(bot.id, BOT_EVENTS_PER_BOT))));
    }
    events.sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    );
    return {
      bots,
      jobs,
      sessions,
      asks,
      notes,
      events,
      revision: yield* Ref.get(revision),
    };
  });

  const snapshotForOwner = Effect.fnUntraced(function* (memberId: MemberId) {
    const bots = (yield* db(store.listBots())).filter((bot) => bot.ownerId === memberId);
    return yield* snapshotOf(bots);
  });

  const appendEvent = Effect.fnUntraced(function* (
    bot: Bot,
    partial: {
      readonly jobId?: BotJobId | null;
      readonly kind: BotEventKind;
      readonly text: string;
      readonly sessionThreadId?: ThreadId | null;
      readonly decision?: BotDecision | null;
    },
  ) {
    const event: BotEvent = {
      id: yield* newEventId(random),
      botId: bot.id,
      jobId: partial.jobId ?? null,
      kind: partial.kind,
      text: partial.text,
      sessionThreadId: partial.sessionThreadId ?? null,
      decision: partial.decision ?? null,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    };
    yield* db(store.upsertEvent(event));
    return event;
  });

  const appendAsk = Effect.fnUntraced(function* (
    bot: Bot,
    input: {
      readonly jobId: BotJobId | null;
      readonly question: string;
      readonly why: string;
      readonly options: ReadonlyArray<string>;
      readonly pick: string | null;
      readonly homeRunId?: RunId | null;
    },
  ) {
    const at = DateTime.formatIso(yield* DateTime.now);
    const ask: BotAsk = {
      id: yield* newAskId(random),
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
      homeRunId: input.homeRunId ?? null,
      createdAt: at,
      answeredAt: null,
    };
    yield* db(store.upsertAsk(ask));
    yield* appendEvent(bot, {
      jobId: input.jobId,
      kind: "asked",
      text: `Asked: ${input.question}`,
    });
    return ask;
  });

  const linkAsk = Effect.fnUntraced(function* (askId: BotAskId, noteId: BotNoteId) {
    const ask = Option.getOrNull(yield* db(store.getAsk(askId)));
    if (ask !== null) yield* db(store.upsertAsk({ ...ask, noteId }));
  });

  const appendNote = Effect.fnUntraced(function* (
    bot: Bot,
    input: {
      readonly text: string;
      readonly source: string;
      readonly sourceJobId: BotJobId | null;
      readonly askId?: BotAskId;
    },
  ) {
    const key = noteKey(input.text);
    const same = (yield* db(store.listNotes(bot.id))).find((note) => noteKey(note.text) === key);
    if (same !== undefined) {
      if (input.askId !== undefined) yield* linkAsk(input.askId, same.id);
      return same;
    }
    const at = DateTime.formatIso(yield* DateTime.now);
    const note: BotNote = {
      id: yield* newNoteId(random),
      botId: bot.id,
      text: input.text,
      source: input.source,
      sourceJobId: input.sourceJobId,
      citedCount: 0,
      createdAt: at,
      updatedAt: at,
    };
    yield* db(store.upsertNote(note));
    yield* appendEvent(bot, {
      jobId: input.sourceJobId,
      kind: "note-saved",
      text: `Saved a note: ${input.text}`,
    });
    if (input.askId !== undefined) yield* linkAsk(input.askId, note.id);
    return note;
  });

  /** One line, trimmed to 80 chars, so a long request still has a job title. */
  const titleOf = (request: string) => {
    const first = request.split("\n")[0]?.trim() ?? "";
    const source = first.length === 0 ? request : first;
    return (source.length > 80 ? source.slice(0, 80) : source) as BotJob["title"];
  };

  const subscribe: BotService["Service"]["subscribe"] = (caller) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const initial = yield* snapshotForOwner(caller.memberId);
        const changes = Stream.fromPubSub(ownerWrites).pipe(
          Stream.filter((ownerId) => ownerId === caller.memberId),
          Stream.mapEffect(() => snapshotForOwner(caller.memberId)),
        );
        return Stream.concat(Stream.succeed(initial), changes);
      }),
    );

  const create: BotService["Service"]["create"] = Effect.fn("BotService.create")(
    function* (caller, input) {
      if (options.cloudOnly) {
        return yield* new BotsError({
          reason: "cloud-only",
          message: "Bots need a machine to run on; this server is cloud-only.",
        });
      }
      return yield* withLock(
        Effect.gen(function* () {
          const mine = (yield* db(store.listBots())).filter(
            (bot) => bot.ownerId === caller.memberId,
          );
          const at = DateTime.formatIso(yield* DateTime.now);
          const face = nextBotFace(mine);
          const bot: Bot = {
            id: yield* newBotId(random),
            ownerId: caller.memberId,
            name: input.name ?? nextBotName(mine),
            color: input.color ?? face.color,
            shape: input.shape ?? face.shape,
            voice: input.voice ?? "crisp",
            picture: null,
            charter: input.charter,
            instructions: input.starter === "default" ? BOT_DEFAULT_INSTRUCTIONS : "",
            limits: input.starter === "default" ? [...BOT_DEFAULT_LIMITS] : [],
            models: input.models ?? {
              brain: BRAIN_MODEL,
              worker: WORKER_MODEL,
              reviewer: BRAIN_MODEL,
            },
            homeThreadId: null,
            homeProjectId: null,
            paused: false,
            lastSeenAt: null,
            nextJobNumber: 1,
            createdAt: at,
            updatedAt: at,
          };
          yield* db(store.upsertBot(bot));
          yield* touch(caller.memberId);
          yield* wake({
            botId: bot.id,
            reason: "created",
            label: "Bot created",
            // BotHome only sets up the home thread for this one; the bot takes no turn.
            text: "Bot created",
          });
          return bot;
        }),
      );
    },
  );

  const update: BotService["Service"]["update"] = Effect.fn("BotService.update")(
    function* (caller, input) {
      return yield* withLock(
        Effect.gen(function* () {
          const bot = yield* requireBot(caller, input.botId);
          const instructionsChanged =
            input.instructions !== undefined && input.instructions !== bot.instructions;
          const limitsChanged = input.limits !== undefined && !sameLimits(input.limits, bot.limits);
          const picture =
            input.picture === undefined
              ? bot.picture
              : input.picture === null
                ? null
                : yield* pictures.adopt(input.picture.attachmentId);
          const updated: Bot = {
            ...bot,
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.color === undefined ? {} : { color: input.color }),
            ...(input.shape === undefined ? {} : { shape: input.shape }),
            ...(input.voice === undefined ? {} : { voice: input.voice }),
            picture,
            ...(input.charter === undefined ? {} : { charter: input.charter }),
            ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
            ...(input.limits === undefined ? {} : { limits: input.limits }),
            ...(input.models === undefined ? {} : { models: input.models }),
            updatedAt: DateTime.formatIso(yield* DateTime.now),
          };
          yield* db(store.upsertBot(updated));
          if (bot.picture !== null && bot.picture.attachmentId !== picture?.attachmentId) {
            yield* pictures.discard(bot.picture);
          }
          yield* touch(bot.ownerId);
          if (instructionsChanged || limitsChanged) {
            yield* wake({
              botId: bot.id,
              reason: "playbook-changed",
              label: "Playbook changed",
              text: "Your playbook or settings changed. Call bot_brief before your next decision.",
            });
          }
          return updated;
        }),
      );
    },
  );

  const setPaused = (caller: BotCaller, input: BotsBotInput, paused: boolean) =>
    withLock(
      Effect.gen(function* () {
        const bot = yield* requireBot(caller, input.botId);
        const updated: Bot = {
          ...bot,
          paused,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
        yield* db(store.upsertBot(updated));
        yield* touch(bot.ownerId);
        if (!paused) {
          yield* wake({
            botId: bot.id,
            reason: "resumed",
            label: "Resumed",
            text: "You were resumed. Call bot_brief to catch up on what happened while you were paused.",
          });
        }
        return updated;
      }),
    );

  const pause: BotService["Service"]["pause"] = Effect.fn("BotService.pause")(
    function* (caller, input) {
      return yield* setPaused(caller, input, true);
    },
  );
  const resume: BotService["Service"]["resume"] = Effect.fn("BotService.resume")(
    function* (caller, input) {
      return yield* setPaused(caller, input, false);
    },
  );

  const remove: BotService["Service"]["delete"] = Effect.fn("BotService.delete")(
    function* (caller, input) {
      return yield* withLock(
        Effect.gen(function* () {
          const bot = yield* requireBot(caller, input.botId);
          if (bot.homeThreadId !== null) {
            yield* stopThread(bot.homeThreadId, "Bot deleted");
            BotThreads.clearHome(bot.homeThreadId);
          }
          // Sessions are not stopped; they become ordinary threads.
          for (const session of yield* db(store.listSessions(bot.id))) {
            BotThreads.clearSession(session.threadId);
          }
          yield* db(store.deleteBot(bot.id));
          if (bot.picture !== null) yield* pictures.discard(bot.picture);
          yield* touch(bot.ownerId);
          return {};
        }),
      );
    },
  );

  const markSeen: BotService["Service"]["markSeen"] = Effect.fn("BotService.markSeen")(
    function* (caller, input) {
      return yield* withLock(
        Effect.gen(function* () {
          const bot = yield* requireBot(caller, input.botId);
          yield* db(
            store.upsertBot({ ...bot, lastSeenAt: DateTime.formatIso(yield* DateTime.now) }),
          );
          yield* touch(bot.ownerId);
          return {};
        }),
      );
    },
  );

  /** The record every new job shares; the user RPC wakes, the bot's own tool does not. */
  const insertJob = Effect.fnUntraced(function* (
    bot: Bot,
    input: {
      readonly title?: BotJob["title"];
      readonly request: string;
      readonly projectId?: ProjectId;
    },
  ) {
    const at = DateTime.formatIso(yield* DateTime.now);
    const number = bot.nextJobNumber;
    const id = yield* newJobId(random);
    const job: BotJob = {
      id,
      botId: bot.id,
      number,
      title: input.title ?? titleOf(input.request),
      request: input.request,
      projectId: input.projectId ?? null,
      status: "working",
      headline: "",
      headlineAt: null,
      pullRequests: [],
      report: null,
      createdAt: at,
      updatedAt: at,
      finishedAt: null,
      archivedAt: null,
    };
    yield* db(store.upsertJob(job));
    // No `updatedAt`: that sends the bot a whole brief, and the new job shows in a diff anyway.
    yield* db(store.upsertBot({ ...bot, nextJobNumber: number + 1 }));
    yield* appendEvent(bot, {
      jobId: id,
      kind: "job-started",
      text: `Started ${job.title}`,
    });
    yield* touch(bot.ownerId);
    return job;
  });

  const createJob: BotService["Service"]["createJob"] = Effect.fn("BotService.createJob")(
    function* (caller, input) {
      return yield* withLock(
        Effect.gen(function* () {
          const bot = yield* requireBot(caller, input.botId);
          const job = yield* insertJob(bot, {
            request: input.request,
            ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          });
          if (!bot.paused) {
            const project =
              input.projectId === undefined
                ? " Pick the project."
                : ` Project: ${input.projectId}.`;
            yield* wake({
              botId: bot.id,
              reason: "job-started",
              label: "New job",
              text: `New job "${job.title}" (jobId ${job.id}): ${input.request}${project}`,
            });
          }
          return job;
        }),
      );
    },
  );

  const createJobForBot: BotService["Service"]["createJobForBot"] = Effect.fn(
    "BotService.createJobForBot",
  )(function* (botId, input) {
    return yield* withLock(
      Effect.gen(function* () {
        const bot = yield* loadBot(botId);
        return yield* insertJob(bot, input);
      }),
    );
  });

  const stopJob: BotService["Service"]["stopJob"] = Effect.fn("BotService.stopJob")(
    function* (caller, input) {
      return yield* withLock(
        Effect.gen(function* () {
          const job = Option.getOrNull(yield* db(store.getJob(input.jobId)));
          if (job === null) return yield* notFound("That job is gone.");
          const bot = yield* requireBot(caller, job.botId);
          const at = DateTime.formatIso(yield* DateTime.now);
          const updated: BotJob = { ...job, status: "stopped", finishedAt: at, updatedAt: at };
          yield* db(store.upsertJob(updated));
          for (const session of yield* db(store.listSessionsForJob(job.id))) {
            yield* stopThread(session.threadId, "Bot job stopped");
          }
          yield* appendEvent(bot, {
            jobId: job.id,
            kind: "job-stopped",
            text: `Stopped ${job.title}`,
          });
          yield* touch(bot.ownerId);
          yield* wake({
            botId: bot.id,
            reason: "job-stopped",
            label: "Job stopped",
            text: `The user stopped the job "${job.title}" (jobId ${job.id}). Don't start new work for it.`,
          });
          return updated;
        }),
      );
    },
  );

  const reopenJob: BotService["Service"]["reopenJob"] = Effect.fn("BotService.reopenJob")(
    function* (caller, input) {
      return yield* withLock(
        Effect.gen(function* () {
          const job = Option.getOrNull(yield* db(store.getJob(input.jobId)));
          if (job === null) return yield* notFound("That job is gone.");
          const bot = yield* requireBot(caller, job.botId);
          if (job.status === "working") {
            return yield* invalidRequest("That job is already working.");
          }
          const at = DateTime.formatIso(yield* DateTime.now);
          const updated: BotJob = {
            ...job,
            status: "working",
            finishedAt: null,
            archivedAt: null,
            report: null,
            updatedAt: at,
          };
          yield* db(store.upsertJob(updated));
          yield* appendEvent(bot, {
            jobId: job.id,
            kind: "job-reopened",
            text: `Reopened ${job.title}`,
          });
          yield* touch(bot.ownerId);
          yield* wake({
            botId: bot.id,
            reason: "job-reopened",
            label: "Job reopened",
            text: `The user reopened the job "${job.title}" (jobId ${job.id}). Pick it up where it stopped; call bot_brief.`,
          });
          return updated;
        }),
      );
    },
  );

  const archiveJob: BotService["Service"]["archiveJob"] = Effect.fn("BotService.archiveJob")(
    function* (caller, input) {
      return yield* withLock(
        Effect.gen(function* () {
          const job = Option.getOrNull(yield* db(store.getJob(input.jobId)));
          if (job === null) return yield* notFound("That job is gone.");
          const bot = yield* requireBot(caller, job.botId);
          const at = DateTime.formatIso(yield* DateTime.now);
          const archivedAt = yield* archivedAtFor(job, input.archived, at);
          if (archivedAt === job.archivedAt) return job;
          const updated: BotJob = { ...job, archivedAt, updatedAt: at };
          yield* db(store.upsertJob(updated));
          yield* touch(bot.ownerId);
          return updated;
        }),
      );
    },
  );

  /** A job named the way the bot acts on it: title, then id. Never its number. */
  const jobRefOf = Effect.fnUntraced(function* (jobId: BotJobId | null) {
    if (jobId === null) return "the job";
    const job = Option.getOrNull(yield* db(store.getJob(jobId)));
    return job === null ? "the job" : `the job \"${job.title}\" (jobId ${job.id})`;
  });

  const answerAsk: BotService["Service"]["answerAsk"] = Effect.fn("BotService.answerAsk")(
    function* (caller, input) {
      return yield* withLock(
        Effect.gen(function* () {
          const ask = Option.getOrNull(yield* db(store.getAsk(input.askId)));
          if (ask === null) return yield* notFound("That ask is gone.");
          const bot = yield* requireBot(caller, ask.botId);
          // Answering again is how the user changes their answer, unless they only meant to answer.
          const changed = ask.status === "answered";
          if (changed && input.ifOpen === true) {
            return yield* new BotsError({
              reason: "already-answered",
              message: "That question was already answered.",
            });
          }
          if (changed && input.kind === "bot-decides" && ask.answerKind === "bot-decides") {
            return yield* invalidRequest("You already let the bot decide that.");
          }
          if (
            input.kind !== "bot-decides" &&
            (input.answer === undefined || input.answer.trim().length === 0)
          ) {
            return yield* invalidRequest("An answer is required.");
          }
          const at = DateTime.formatIso(yield* DateTime.now);
          const answer = input.kind === "bot-decides" ? null : (input.answer ?? null);
          const updated: BotAsk = {
            ...ask,
            status: "answered",
            answerKind: input.kind,
            answer,
            answeredAt: at,
            remember: input.remember,
          };
          yield* db(store.upsertAsk(updated));
          yield* appendEvent(bot, {
            jobId: ask.jobId,
            kind: "answered",
            text:
              input.kind === "bot-decides"
                ? `You let ${bot.name} decide`
                : `${changed ? "You changed your answer to" : "You answered"}: ${answer ?? ""}`,
          });
          yield* touch(bot.ownerId);
          const jobRef = yield* jobRefOf(ask.jobId);
          if (input.kind === "bot-decides") {
            yield* wake({
              botId: bot.id,
              reason: "ask-answered",
              label: "You answered",
              text: `The user let you decide Ask ${ask.id} on ${jobRef}. Decide, act on it, and record it with bot_ask_resolve (decision cite "You let ${bot.name} decide").`,
            });
          } else {
            const remember = input.remember
              ? ` They want you to remember this: save one short note with bot_learn (askId ${ask.id}).`
              : "";
            const verb = changed
              ? `changed their answer to Ask ${ask.id} on ${jobRef} from "${ask.answer ?? "you decide"}" to`
              : `answered Ask ${ask.id} on ${jobRef}:`;
            const redo = changed
              ? " Act on the new answer, and undo work that followed the old one."
              : "";
            yield* wake({
              botId: bot.id,
              reason: "ask-answered",
              label: "You answered",
              text: `The user ${verb} "${answer ?? ""}".${redo}${remember}`,
            });
          }
          return updated;
        }),
      );
    },
  );

  const rememberAsk: BotService["Service"]["rememberAsk"] = Effect.fn("BotService.rememberAsk")(
    function* (caller, input) {
      return yield* withLock(
        Effect.gen(function* () {
          const ask = Option.getOrNull(yield* db(store.getAsk(input.askId)));
          if (ask === null) return yield* notFound("That ask is gone.");
          const bot = yield* requireBot(caller, ask.botId);
          if (ask.status !== "answered" || ask.noteId !== null) {
            return yield* invalidRequest("That answer is not waiting for a note.");
          }
          const updated: BotAsk = { ...ask, remember: true };
          yield* db(store.upsertAsk(updated));
          yield* touch(bot.ownerId);
          yield* wake({
            botId: bot.id,
            reason: "ask-remember",
            label: "Remember this",
            text: `Save one short note from the user's answer to Ask ${ask.id} with bot_learn (askId ${ask.id}).`,
          });
          return updated;
        }),
      );
    },
  );

  const correctDecision: BotService["Service"]["correctDecision"] = Effect.fn(
    "BotService.correctDecision",
  )(function* (caller, input) {
    return yield* withLock(
      Effect.gen(function* () {
        const event = Option.getOrNull(yield* db(store.getEvent(input.eventId)));
        if (event === null) return yield* notFound("That decision is gone.");
        const bot = yield* requireBot(caller, event.botId);
        const decision = event.decision;
        if (event.kind !== "decision" || decision === null) {
          return yield* invalidRequest("That event is not a decision.");
        }
        const updated: BotEvent = {
          ...event,
          decision: { ...decision, correction: input.correction },
        };
        yield* db(store.upsertEvent(updated));
        yield* appendEvent(bot, {
          jobId: event.jobId,
          kind: "correction",
          text: `Corrected: ${input.correction}`,
          sessionThreadId: event.sessionThreadId,
        });
        yield* touch(bot.ownerId);
        yield* wake({
          botId: bot.id,
          reason: "decision-corrected",
          label: "You corrected a decision",
          text: `The user corrected your decision ${event.id} on session "${decision.sessionTitle}" ("${decision.question}" → "${decision.answer}"): "${input.correction}". Re-steer that session if it is still running (bot_session_message), and offer to edit the cited note.`,
        });
        return updated;
      }),
    );
  });

  const handBackSession: BotService["Service"]["handBackSession"] = Effect.fn(
    "BotService.handBackSession",
  )(function* (caller, input) {
    return yield* withLock(
      Effect.gen(function* () {
        const session = Option.getOrNull(yield* db(store.getSession(input.threadId)));
        if (session === null) return yield* notFound("That session is gone.");
        const bot = yield* requireBot(caller, session.botId);
        const updated: BotSession = { ...session, takenOver: false };
        yield* db(store.upsertSession(updated));
        yield* appendEvent(bot, {
          jobId: session.jobId,
          kind: "session-handed-back",
          text: `Handed back ${session.title}`,
          sessionThreadId: session.threadId,
        });
        yield* touch(bot.ownerId);
        yield* wake({
          botId: bot.id,
          reason: "session-handed-back",
          label: `${session.title} was handed back`,
          text: `The user handed session "${session.title}" (thread ${session.threadId}) back to you. Read what changed with t3_thread_read, then continue.`,
        });
        return updated;
      }),
    );
  });

  const updateNote: BotService["Service"]["updateNote"] = Effect.fn("BotService.updateNote")(
    function* (caller, input) {
      return yield* withLock(
        Effect.gen(function* () {
          const note = Option.getOrNull(yield* db(store.getNote(input.noteId)));
          if (note === null) return yield* notFound("That note is gone.");
          const bot = yield* requireBot(caller, note.botId);
          const updated: BotNote = {
            ...note,
            text: input.text,
            updatedAt: DateTime.formatIso(yield* DateTime.now),
          };
          yield* db(store.upsertNote(updated));
          yield* touch(bot.ownerId);
          return updated;
        }),
      );
    },
  );

  const deleteNote: BotService["Service"]["deleteNote"] = Effect.fn("BotService.deleteNote")(
    function* (caller, input) {
      return yield* withLock(
        Effect.gen(function* () {
          const note = Option.getOrNull(yield* db(store.getNote(input.noteId)));
          if (note === null) return yield* notFound("That note is gone.");
          const bot = yield* requireBot(caller, note.botId);
          yield* db(store.deleteNote(note.id));
          // The bot's next brief comes whole, so it drops the note it holds from earlier briefs.
          yield* db(
            store.upsertBot({ ...bot, updatedAt: DateTime.formatIso(yield* DateTime.now) }),
          );
          yield* touch(bot.ownerId);
          return {};
        }),
      );
    },
  );

  const forgetNote: BotService["Service"]["forgetNote"] = Effect.fn("BotService.forgetNote")(
    function* (botId, noteId) {
      return yield* withLock(
        Effect.gen(function* () {
          const note = Option.getOrNull(yield* db(store.getNote(noteId)));
          if (note === null || note.botId !== botId) return yield* notFound("That note is gone.");
          const bot = yield* loadBot(note.botId);
          yield* db(store.deleteNote(note.id));
          yield* touch(bot.ownerId);
          return note;
        }),
      );
    },
  );

  const getBot: BotService["Service"]["getBot"] = Effect.fn("BotService.getBot")(function* (id) {
    return yield* db(store.getBot(id));
  });
  const listAllBots: BotService["Service"]["listAllBots"] = Effect.fn("BotService.listAllBots")(
    function* () {
      return yield* db(store.listBots());
    },
  );
  const botForHomeThread: BotService["Service"]["botForHomeThread"] = Effect.fn(
    "BotService.botForHomeThread",
  )(function* (threadId) {
    const id = BotThreads.homeBotId(threadId);
    if (id === undefined) return Option.none<Bot>();
    return yield* db(store.getBot(BotIdValue.make(id)));
  });
  const sessionForThread: BotService["Service"]["sessionForThread"] = Effect.fn(
    "BotService.sessionForThread",
  )(function* (threadId) {
    return yield* db(store.getSession(threadId));
  });
  const snapshotForBot: BotService["Service"]["snapshotForBot"] = Effect.fn(
    "BotService.snapshotForBot",
  )(function* (id) {
    const bot = yield* loadBot(id);
    return yield* snapshotOf([bot]);
  });

  const getJob: BotService["Service"]["getJob"] = Effect.fn("BotService.getJob")(function* (jobId) {
    return yield* db(store.getJob(jobId));
  });
  const listJobs: BotService["Service"]["listJobs"] = Effect.fn("BotService.listJobs")(
    function* (botId) {
      return yield* db(store.listJobs(botId));
    },
  );
  const listSessions: BotService["Service"]["listSessions"] = Effect.fn("BotService.listSessions")(
    function* (botId) {
      return yield* db(store.listSessions(botId));
    },
  );
  const listAsks: BotService["Service"]["listAsks"] = Effect.fn("BotService.listAsks")(
    function* (botId) {
      return yield* db(store.listAsks(botId));
    },
  );

  const setHome: BotService["Service"]["setHome"] = Effect.fn("BotService.setHome")(
    function* (id, input) {
      return yield* withLock(
        Effect.gen(function* () {
          const bot = yield* loadBot(id);
          if (bot.homeThreadId !== null && bot.homeThreadId !== input.homeThreadId) {
            BotThreads.clearHome(bot.homeThreadId);
          }
          const updated: Bot = {
            ...bot,
            homeThreadId: input.homeThreadId,
            homeProjectId: input.homeProjectId,
          };
          yield* db(store.upsertBot(updated));
          BotThreads.setHome(input.homeThreadId, bot.id);
          yield* touch(bot.ownerId);
          return updated;
        }),
      );
    },
  );

  const updateJob: BotService["Service"]["updateJob"] = Effect.fn("BotService.updateJob")(
    function* (id, jobIdValue, patch) {
      return yield* withLock(
        Effect.gen(function* () {
          const bot = yield* loadBot(id);
          const job = Option.getOrNull(yield* db(store.getJob(jobIdValue)));
          if (job === null || job.botId !== bot.id) return yield* notFound("That job is gone.");
          if (patch.status === "working" && job.status === "stopped") {
            return yield* invalidRequest(
              "The user stopped this job; ask them before restarting it.",
            );
          }
          const reopening = patch.status === "working" && job.status === "done";
          const at = DateTime.formatIso(yield* DateTime.now);
          const patched: BotJob = {
            ...job,
            ...(patch.title === undefined ? {} : { title: patch.title }),
            ...(patch.headline === undefined ? {} : { headline: patch.headline }),
            ...(patch.status === undefined ? {} : { status: patch.status }),
            ...(patch.report === undefined ? {} : { report: patch.report }),
            ...(patch.pullRequests === undefined ? {} : { pullRequests: patch.pullRequests }),
            ...(patch.headline === undefined ? {} : { headlineAt: at }),
            ...(patch.status === "done" ? { finishedAt: at } : {}),
            ...(reopening ? { finishedAt: null, archivedAt: null } : {}),
            updatedAt: at,
          };
          const updated: BotJob = {
            ...patched,
            archivedAt: yield* archivedAtFor(patched, patch.archived, at),
          };
          yield* db(store.upsertJob(updated));
          if (patch.status === "done") {
            yield* appendEvent(bot, { jobId: job.id, kind: "job-done", text: "Done" });
          }
          if (reopening) {
            yield* appendEvent(bot, {
              jobId: job.id,
              kind: "job-reopened",
              text: `Reopened ${job.title}`,
            });
          }
          yield* touch(bot.ownerId);
          return updated;
        }),
      );
    },
  );

  const addSession: BotService["Service"]["addSession"] = Effect.fn("BotService.addSession")(
    function* (session) {
      return yield* withLock(
        Effect.gen(function* () {
          const bot = yield* loadBot(session.botId);
          yield* db(store.upsertSession(session));
          BotThreads.setSession(session.threadId, session.botId);
          yield* appendEvent(bot, {
            jobId: session.jobId,
            kind: "session-started",
            text: `Started ${session.title}`,
            sessionThreadId: session.threadId,
          });
          yield* touch(bot.ownerId);
          return session;
        }),
      );
    },
  );

  const setSessionCloud: BotService["Service"]["setSessionCloud"] = Effect.fn(
    "BotService.setSessionCloud",
  )(function* (threadId, cloud) {
    return yield* withLock(
      Effect.gen(function* () {
        const session = Option.getOrNull(yield* db(store.getSession(threadId)));
        if (session === null) return yield* notFound("That session is gone.");
        const bot = yield* loadBot(session.botId);
        const updated: BotSession = { ...session, cloud };
        yield* db(store.upsertSession(updated));
        yield* touch(bot.ownerId);
        return updated;
      }),
    );
  });

  const setSessionArchived: BotService["Service"]["setSessionArchived"] = Effect.fn(
    "BotService.setSessionArchived",
  )(function* (threadId, archived) {
    return yield* withLock(
      Effect.gen(function* () {
        const session = Option.getOrNull(yield* db(store.getSession(threadId)));
        if (session === null) return yield* notFound("That session is gone.");
        const bot = yield* loadBot(session.botId);
        const { archived: _archived, ...rest } = session;
        const updated: BotSession = archived === undefined ? rest : { ...rest, archived };
        yield* db(store.upsertSession(updated));
        yield* touch(bot.ownerId);
        return updated;
      }),
    );
  });

  const setSessionTakenOver: BotService["Service"]["setSessionTakenOver"] = Effect.fn(
    "BotService.setSessionTakenOver",
  )(function* (threadId, takenOver) {
    return yield* withLock(
      Effect.gen(function* () {
        const session = Option.getOrNull(yield* db(store.getSession(threadId)));
        if (session === null) return yield* notFound("That session is gone.");
        const bot = yield* loadBot(session.botId);
        const updated: BotSession = { ...session, takenOver };
        yield* db(store.upsertSession(updated));
        BotThreads.setSession(session.threadId, session.botId);
        if (takenOver && !session.takenOver) {
          yield* appendEvent(bot, {
            jobId: session.jobId,
            kind: "session-taken-over",
            text: `You took over ${session.title}`,
            sessionThreadId: session.threadId,
          });
        }
        if (!takenOver && session.takenOver) {
          yield* appendEvent(bot, {
            jobId: session.jobId,
            kind: "session-handed-back",
            text: `Handed back ${session.title}`,
            sessionThreadId: session.threadId,
          });
        }
        yield* touch(bot.ownerId);
        return updated;
      }),
    );
  });

  const addEvent: BotService["Service"]["addEvent"] = Effect.fn("BotService.addEvent")(
    function* (input) {
      return yield* withLock(
        Effect.gen(function* () {
          const bot = yield* loadBot(input.botId);
          const event = yield* appendEvent(bot, {
            jobId: input.jobId ?? null,
            kind: input.kind,
            text: input.text,
            sessionThreadId: input.sessionThreadId ?? null,
            decision: input.decision ?? null,
          });
          yield* touch(bot.ownerId);
          return event;
        }),
      );
    },
  );

  const createAsk: BotService["Service"]["createAsk"] = Effect.fn("BotService.createAsk")(
    function* (id, input) {
      return yield* withLock(
        Effect.gen(function* () {
          const bot = yield* loadBot(id);
          const ask = yield* appendAsk(bot, input);
          yield* touch(bot.ownerId);
          return ask;
        }),
      );
    },
  );

  const resolveAsk: BotService["Service"]["resolveAsk"] = Effect.fn("BotService.resolveAsk")(
    function* (id, askIdValue, input) {
      return yield* withLock(
        Effect.gen(function* () {
          const bot = yield* loadBot(id);
          const ask = Option.getOrNull(yield* db(store.getAsk(askIdValue)));
          if (ask === null || ask.botId !== bot.id) return yield* notFound("That ask is gone.");
          const updated: BotAsk = {
            ...ask,
            status: "answered",
            answerKind: input.answerKind,
            answer: input.answer,
            answeredAt: DateTime.formatIso(yield* DateTime.now),
          };
          yield* db(store.upsertAsk(updated));
          yield* appendEvent(bot, {
            jobId: ask.jobId,
            kind: "answered",
            text:
              input.eventText ??
              (input.answerKind === "bot-decides"
                ? `${bot.name} decided: ${input.answer ?? ""}`
                : `You answered in Chat: ${input.answer ?? ""}`),
          });
          yield* touch(bot.ownerId);
          return updated;
        }),
      );
    },
  );

  const addNote: BotService["Service"]["addNote"] = Effect.fn("BotService.addNote")(
    function* (id, input) {
      return yield* withLock(
        Effect.gen(function* () {
          const bot = yield* loadBot(id);
          const note = yield* appendNote(bot, input);
          yield* touch(bot.ownerId);
          return note;
        }),
      );
    },
  );

  const citeNote: BotService["Service"]["citeNote"] = Effect.fn("BotService.citeNote")(
    function* (noteIdValue) {
      return yield* withLock(
        Effect.gen(function* () {
          const note = Option.getOrNull(yield* db(store.getNote(noteIdValue)));
          if (note === null) return yield* notFound("That note is gone.");
          const bot = yield* loadBot(note.botId);
          const updated: BotNote = {
            ...note,
            // Not `updatedAt`: a citation changes ranking, not the note, so diffs don't resend it.
            citedCount: note.citedCount + 1,
          };
          yield* db(store.upsertNote(updated));
          yield* touch(bot.ownerId);
          return updated;
        }),
      );
    },
  );

  // Fill the synchronous thread index from the database.
  for (const bot of yield* db(store.listBots())) {
    if (bot.homeThreadId !== null) BotThreads.setHome(bot.homeThreadId, bot.id);
    for (const session of yield* db(store.listSessions(bot.id))) {
      BotThreads.setSession(session.threadId, session.botId);
    }
  }

  return BotService.of({
    subscribe,
    create,
    update,
    pause,
    resume,
    delete: remove,
    markSeen,
    createJob,
    createJobForBot,
    stopJob,
    reopenJob,
    archiveJob,
    answerAsk,
    rememberAsk,
    correctDecision,
    handBackSession,
    updateNote,
    deleteNote,
    forgetNote,
    wakes: Stream.fromPubSub(wakePubSub),
    publishWake: wake,
    changes: Stream.fromPubSub(ownerWrites),
    getBot,
    listAllBots,
    botForHomeThread,
    sessionForThread,
    snapshotForBot,
    getJob,
    listJobs,
    listSessions,
    listAsks,
    setHome,
    updateJob,
    addSession,
    setSessionCloud,
    setSessionArchived,
    setSessionTakenOver,
    addEvent,
    createAsk,
    resolveAsk,
    addNote,
    citeNote,
  });
});

export const layer = (options: { readonly cloudOnly: boolean }) =>
  Layer.effect(BotService, make(options));
