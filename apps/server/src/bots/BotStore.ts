import {
  Bot,
  BotAsk,
  type BotAskId,
  BotEvent,
  type BotEventId,
  type BotId,
  BotJob,
  type BotJobId,
  BotNote,
  type BotNoteId,
  BotSession,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  PersistenceDecodeError,
  toPersistenceSqlError,
  type BotRepositoryError,
} from "../persistence/Errors.ts";

const BotRow = Schema.Struct({ data: Schema.fromJsonString(Bot) });
const JobRow = Schema.Struct({ data: Schema.fromJsonString(BotJob) });
const SessionRow = Schema.Struct({ data: Schema.fromJsonString(BotSession) });
const AskRow = Schema.Struct({ data: Schema.fromJsonString(BotAsk) });
const NoteRow = Schema.Struct({ data: Schema.fromJsonString(BotNote) });
const EventRow = Schema.Struct({ data: Schema.fromJsonString(BotEvent) });

const toError =
  (operation: string) =>
  (cause: unknown): BotRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(operation, cause)
      : toPersistenceSqlError(operation)(cause);

/** Persists every Bots entity as its encoded schema value, with a few indexed key columns. */
export class BotStore extends Context.Service<
  BotStore,
  {
    readonly getBot: (botId: BotId) => Effect.Effect<Option.Option<Bot>, BotRepositoryError>;
    readonly listBots: () => Effect.Effect<ReadonlyArray<Bot>, BotRepositoryError>;
    readonly upsertBot: (bot: Bot) => Effect.Effect<void, BotRepositoryError>;

    readonly getJob: (jobId: BotJobId) => Effect.Effect<Option.Option<BotJob>, BotRepositoryError>;
    readonly listJobs: (botId: BotId) => Effect.Effect<ReadonlyArray<BotJob>, BotRepositoryError>;
    readonly upsertJob: (job: BotJob) => Effect.Effect<void, BotRepositoryError>;

    readonly getSession: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<BotSession>, BotRepositoryError>;
    readonly listSessions: (
      botId: BotId,
    ) => Effect.Effect<ReadonlyArray<BotSession>, BotRepositoryError>;
    readonly listSessionsForJob: (
      jobId: BotJobId,
    ) => Effect.Effect<ReadonlyArray<BotSession>, BotRepositoryError>;
    readonly upsertSession: (session: BotSession) => Effect.Effect<void, BotRepositoryError>;

    readonly getAsk: (askId: BotAskId) => Effect.Effect<Option.Option<BotAsk>, BotRepositoryError>;
    readonly listAsks: (botId: BotId) => Effect.Effect<ReadonlyArray<BotAsk>, BotRepositoryError>;
    readonly upsertAsk: (ask: BotAsk) => Effect.Effect<void, BotRepositoryError>;

    readonly getNote: (
      noteId: BotNoteId,
    ) => Effect.Effect<Option.Option<BotNote>, BotRepositoryError>;
    readonly listNotes: (botId: BotId) => Effect.Effect<ReadonlyArray<BotNote>, BotRepositoryError>;
    readonly upsertNote: (note: BotNote) => Effect.Effect<void, BotRepositoryError>;
    readonly deleteNote: (noteId: BotNoteId) => Effect.Effect<void, BotRepositoryError>;

    readonly getEvent: (
      eventId: BotEventId,
    ) => Effect.Effect<Option.Option<BotEvent>, BotRepositoryError>;
    /** Newest first. */
    readonly listEvents: (
      botId: BotId,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<BotEvent>, BotRepositoryError>;
    readonly upsertEvent: (event: BotEvent) => Effect.Effect<void, BotRepositoryError>;

    readonly deleteBot: (botId: BotId) => Effect.Effect<void, BotRepositoryError>;
  }
>()("t3/bots/BotStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findBot = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: BotRow,
    execute: (botId) => sql`SELECT data_json AS "data" FROM bots WHERE id = ${botId}`,
  });
  const listBots = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BotRow,
    execute: () => sql`SELECT data_json AS "data" FROM bots ORDER BY created_at, id`,
  });
  const findJob = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: JobRow,
    execute: (jobId) => sql`SELECT data_json AS "data" FROM bot_jobs WHERE id = ${jobId}`,
  });
  const listJobs = SqlSchema.findAll({
    Request: Schema.String,
    Result: JobRow,
    execute: (botId) =>
      sql`SELECT data_json AS "data" FROM bot_jobs WHERE bot_id = ${botId} ORDER BY number`,
  });
  const findSession = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: SessionRow,
    execute: (threadId) =>
      sql`SELECT data_json AS "data" FROM bot_sessions WHERE thread_id = ${threadId}`,
  });
  const listSessions = SqlSchema.findAll({
    Request: Schema.String,
    Result: SessionRow,
    execute: (botId) =>
      sql`SELECT data_json AS "data" FROM bot_sessions WHERE bot_id = ${botId} ORDER BY created_at`,
  });
  const listSessionsForJob = SqlSchema.findAll({
    Request: Schema.String,
    Result: SessionRow,
    execute: (jobId) =>
      sql`SELECT data_json AS "data" FROM bot_sessions WHERE job_id = ${jobId} ORDER BY created_at`,
  });
  const findAsk = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: AskRow,
    execute: (askId) => sql`SELECT data_json AS "data" FROM bot_asks WHERE id = ${askId}`,
  });
  const listAsks = SqlSchema.findAll({
    Request: Schema.String,
    Result: AskRow,
    execute: (botId) =>
      sql`SELECT data_json AS "data" FROM bot_asks WHERE bot_id = ${botId} ORDER BY created_at`,
  });
  const findNote = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: NoteRow,
    execute: (noteId) => sql`SELECT data_json AS "data" FROM bot_notes WHERE id = ${noteId}`,
  });
  const listNotes = SqlSchema.findAll({
    Request: Schema.String,
    Result: NoteRow,
    execute: (botId) =>
      sql`SELECT data_json AS "data" FROM bot_notes WHERE bot_id = ${botId} ORDER BY created_at`,
  });
  const findEvent = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: EventRow,
    execute: (eventId) => sql`SELECT data_json AS "data" FROM bot_events WHERE id = ${eventId}`,
  });
  const listEvents = SqlSchema.findAll({
    Request: Schema.Struct({ botId: Schema.String, limit: Schema.Number }),
    Result: EventRow,
    execute: ({ botId, limit }) => sql`
      SELECT data_json AS "data" FROM bot_events
      WHERE bot_id = ${botId}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `,
  });

  const encodeBot = Schema.encodeEffect(Schema.fromJsonString(Bot));
  const encodeJob = Schema.encodeEffect(Schema.fromJsonString(BotJob));
  const encodeSession = Schema.encodeEffect(Schema.fromJsonString(BotSession));
  const encodeAsk = Schema.encodeEffect(Schema.fromJsonString(BotAsk));
  const encodeNote = Schema.encodeEffect(Schema.fromJsonString(BotNote));
  const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(BotEvent));

  const read = <A, E>(
    operation: string,
    effect: Effect.Effect<Option.Option<{ readonly data: A }>, E>,
  ) =>
    effect.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(toError(operation)),
      Effect.map(Option.map((row) => row.data)),
    );
  const readAll = <A, E>(
    operation: string,
    effect: Effect.Effect<ReadonlyArray<{ readonly data: A }>, E>,
  ) =>
    effect.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(toError(operation)),
      Effect.map((rows) => rows.map((row) => row.data)),
    );

  return BotStore.of({
    getBot: Effect.fn("BotStore.getBot")(function (botId) {
      return read("getBot", findBot(botId));
    }),
    listBots: Effect.fn("BotStore.listBots")(function () {
      return readAll("listBots", listBots(undefined));
    }),
    upsertBot: Effect.fn("BotStore.upsertBot")(function (bot) {
      return encodeBot(bot).pipe(
        Effect.mapError(toError("upsertBot")),
        Effect.flatMap(
          (json) => sql`
            INSERT INTO bots (id, owner_id, home_thread_id, data_json, created_at, updated_at)
            VALUES (${bot.id}, ${bot.ownerId}, ${bot.homeThreadId}, ${json}, ${bot.createdAt}, ${bot.updatedAt})
            ON CONFLICT (id) DO UPDATE SET
              owner_id = excluded.owner_id,
              home_thread_id = excluded.home_thread_id,
              data_json = excluded.data_json,
              updated_at = excluded.updated_at
          `,
        ),
        Effect.mapError(toError("upsertBot")),
        Effect.asVoid,
      );
    }),

    getJob: Effect.fn("BotStore.getJob")(function (jobId) {
      return read("getJob", findJob(jobId));
    }),
    listJobs: Effect.fn("BotStore.listJobs")(function (botId) {
      return readAll("listJobs", listJobs(botId));
    }),
    upsertJob: Effect.fn("BotStore.upsertJob")(function (job) {
      return encodeJob(job).pipe(
        Effect.mapError(toError("upsertJob")),
        Effect.flatMap(
          (json) => sql`
            INSERT INTO bot_jobs (id, bot_id, number, data_json, created_at, updated_at)
            VALUES (${job.id}, ${job.botId}, ${job.number}, ${json}, ${job.createdAt}, ${job.updatedAt})
            ON CONFLICT (id) DO UPDATE SET
              number = excluded.number,
              data_json = excluded.data_json,
              updated_at = excluded.updated_at
          `,
        ),
        Effect.mapError(toError("upsertJob")),
        Effect.asVoid,
      );
    }),

    getSession: Effect.fn("BotStore.getSession")(function (threadId) {
      return read("getSession", findSession(threadId));
    }),
    listSessions: Effect.fn("BotStore.listSessions")(function (botId) {
      return readAll("listSessions", listSessions(botId));
    }),
    listSessionsForJob: Effect.fn("BotStore.listSessionsForJob")(function (jobId) {
      return readAll("listSessionsForJob", listSessionsForJob(jobId));
    }),
    upsertSession: Effect.fn("BotStore.upsertSession")(function (session) {
      return encodeSession(session).pipe(
        Effect.mapError(toError("upsertSession")),
        Effect.flatMap(
          (json) => sql`
            INSERT INTO bot_sessions (thread_id, bot_id, job_id, data_json, created_at)
            VALUES (${session.threadId}, ${session.botId}, ${session.jobId}, ${json}, ${session.createdAt})
            ON CONFLICT (thread_id) DO UPDATE SET
              bot_id = excluded.bot_id,
              job_id = excluded.job_id,
              data_json = excluded.data_json
          `,
        ),
        Effect.mapError(toError("upsertSession")),
        Effect.asVoid,
      );
    }),

    getAsk: Effect.fn("BotStore.getAsk")(function (askId) {
      return read("getAsk", findAsk(askId));
    }),
    listAsks: Effect.fn("BotStore.listAsks")(function (botId) {
      return readAll("listAsks", listAsks(botId));
    }),
    upsertAsk: Effect.fn("BotStore.upsertAsk")(function (ask) {
      return encodeAsk(ask).pipe(
        Effect.mapError(toError("upsertAsk")),
        Effect.flatMap(
          (json) => sql`
            INSERT INTO bot_asks (id, bot_id, job_id, status, data_json, created_at)
            VALUES (${ask.id}, ${ask.botId}, ${ask.jobId}, ${ask.status}, ${json}, ${ask.createdAt})
            ON CONFLICT (id) DO UPDATE SET
              job_id = excluded.job_id,
              status = excluded.status,
              data_json = excluded.data_json
          `,
        ),
        Effect.mapError(toError("upsertAsk")),
        Effect.asVoid,
      );
    }),

    getNote: Effect.fn("BotStore.getNote")(function (noteId) {
      return read("getNote", findNote(noteId));
    }),
    listNotes: Effect.fn("BotStore.listNotes")(function (botId) {
      return readAll("listNotes", listNotes(botId));
    }),
    upsertNote: Effect.fn("BotStore.upsertNote")(function (note) {
      return encodeNote(note).pipe(
        Effect.mapError(toError("upsertNote")),
        Effect.flatMap(
          (json) => sql`
            INSERT INTO bot_notes (id, bot_id, data_json, created_at)
            VALUES (${note.id}, ${note.botId}, ${json}, ${note.createdAt})
            ON CONFLICT (id) DO UPDATE SET data_json = excluded.data_json
          `,
        ),
        Effect.mapError(toError("upsertNote")),
        Effect.asVoid,
      );
    }),
    deleteNote: Effect.fn("BotStore.deleteNote")(function (noteId) {
      return sql`DELETE FROM bot_notes WHERE id = ${noteId}`.pipe(
        Effect.mapError(toPersistenceSqlError("deleteNote")),
        Effect.asVoid,
      );
    }),

    getEvent: Effect.fn("BotStore.getEvent")(function (eventId) {
      return read("getEvent", findEvent(eventId));
    }),
    listEvents: Effect.fn("BotStore.listEvents")(function (botId, limit) {
      return readAll("listEvents", listEvents({ botId, limit }));
    }),
    upsertEvent: Effect.fn("BotStore.upsertEvent")(function (event) {
      return encodeEvent(event).pipe(
        Effect.mapError(toError("upsertEvent")),
        Effect.flatMap(
          (json) => sql`
            INSERT INTO bot_events (id, bot_id, job_id, kind, data_json, created_at)
            VALUES (${event.id}, ${event.botId}, ${event.jobId}, ${event.kind}, ${json}, ${event.createdAt})
            ON CONFLICT (id) DO UPDATE SET
              job_id = excluded.job_id,
              kind = excluded.kind,
              data_json = excluded.data_json
          `,
        ),
        Effect.mapError(toError("upsertEvent")),
        Effect.asVoid,
      );
    }),

    deleteBot: Effect.fn("BotStore.deleteBot")(function (botId) {
      return sql
        .withTransaction(
          Effect.forEach(
            [
              sql`DELETE FROM bots WHERE id = ${botId}`,
              sql`DELETE FROM bot_jobs WHERE bot_id = ${botId}`,
              sql`DELETE FROM bot_sessions WHERE bot_id = ${botId}`,
              sql`DELETE FROM bot_asks WHERE bot_id = ${botId}`,
              sql`DELETE FROM bot_notes WHERE bot_id = ${botId}`,
              sql`DELETE FROM bot_events WHERE bot_id = ${botId}`,
            ],
            (statement) => statement,
            { discard: true },
          ),
        )
        .pipe(Effect.mapError(toPersistenceSqlError("deleteBot")), Effect.asVoid);
    }),
  });
});

export const layer = Layer.effect(BotStore, make);
