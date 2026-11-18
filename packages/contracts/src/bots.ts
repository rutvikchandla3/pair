/**
 * Bots: persistent agents you give jobs. A bot plans in its home thread, starts sessions (ordinary
 * threads) to do the work, answers them from your playbook, and asks you only when it must.
 * Spec: docs/product/bots.md.
 */
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MemberId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const BotId = TrimmedNonEmptyString.pipe(Schema.brand("BotId"));
export type BotId = typeof BotId.Type;
export const BotJobId = TrimmedNonEmptyString.pipe(Schema.brand("BotJobId"));
export type BotJobId = typeof BotJobId.Type;
export const BotAskId = TrimmedNonEmptyString.pipe(Schema.brand("BotAskId"));
export type BotAskId = typeof BotAskId.Type;
export const BotNoteId = TrimmedNonEmptyString.pipe(Schema.brand("BotNoteId"));
export type BotNoteId = typeof BotNoteId.Type;
export const BotEventId = TrimmedNonEmptyString.pipe(Schema.brand("BotEventId"));
export type BotEventId = typeof BotEventId.Type;

/** "Check with me before": the bot raises an Ask instead of deciding these. Instructions, not locks. */
export const BotLimit = Schema.Literals([
  "merge",
  "push-default-branch",
  "delete-outside-job",
  "migrations-deploys",
  "add-dependency",
  "spend-money",
]);
export type BotLimit = typeof BotLimit.Type;

export const BOT_LIMIT_LABELS: Readonly<Record<BotLimit, string>> = {
  merge: "Merging a pull request",
  "push-default-branch": "Pushing to a default branch",
  "delete-outside-job": "Deleting code outside the job",
  "migrations-deploys": "Running migrations or deploys",
  "add-dependency": "Adding a dependency",
  "spend-money": "Anything that spends money",
};

/** The Default starter checks every limit except adding a dependency. */
export const BOT_DEFAULT_LIMITS: ReadonlyArray<BotLimit> = [
  "merge",
  "push-default-branch",
  "delete-outside-job",
  "migrations-deploys",
  "spend-money",
];

export const BOT_DEFAULT_INSTRUCTIONS =
  "Decide code details yourself. Ask me about product copy and anything a user would notice. One PR per concern, and keep diffs boring.";

export const BotStarter = Schema.Literals(["default", "blank"]);
export type BotStarter = typeof BotStarter.Type;

/** Brain thinks in the home thread; Worker runs implementation sessions; Reviewer runs review sessions. */
export const BotModels = Schema.Struct({
  brain: ModelSelection,
  worker: ModelSelection,
  reviewer: ModelSelection,
});
export type BotModels = typeof BotModels.Type;

export const Bot = Schema.Struct({
  id: BotId,
  ownerId: MemberId,
  name: TrimmedNonEmptyString,
  /** A hex colour the server assigns, e.g. `#4f46e5`. */
  color: TrimmedNonEmptyString,
  /** One line: what it's for. May be empty. */
  charter: Schema.String,
  /** Prose the user writes: taste and standing orders. */
  instructions: Schema.String,
  limits: Schema.Array(BotLimit),
  models: BotModels,
  /** The hidden home thread and project; null until the first turn creates them. */
  homeThreadId: Schema.NullOr(ThreadId),
  homeProjectId: Schema.NullOr(ProjectId),
  paused: Schema.Boolean,
  /** When the user last opened the bot's Briefing (`bots.markSeen`). */
  lastSeenAt: Schema.NullOr(IsoDateTime),
  /** The next job number (J-n). */
  nextJobNumber: PositiveInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Bot = typeof Bot.Type;

/** Stored status. "Needs you" is derived from an open Ask on the job. */
export const BotJobStatus = Schema.Literals(["working", "done", "stopped"]);
export type BotJobStatus = typeof BotJobStatus.Type;

export const BotJobReport = Schema.Struct({
  /** What changed, in plain language. */
  changed: Schema.String,
  /** Tests run, captures, checks: one line each. */
  evidence: Schema.Array(Schema.String),
  /** Hidden when empty. */
  openQuestions: Schema.Array(Schema.String),
  /** What to do next, and an optional ready-made request for a Start job button. */
  next: Schema.NullOr(
    Schema.Struct({
      text: Schema.String,
      suggestedRequest: Schema.NullOr(Schema.String),
    }),
  ),
});
export type BotJobReport = typeof BotJobReport.Type;

export const BotJob = Schema.Struct({
  id: BotJobId,
  botId: BotId,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  /** The user's words. */
  request: Schema.String,
  /** The project the user picked; null means the bot picks. */
  projectId: Schema.NullOr(ProjectId),
  status: BotJobStatus,
  /** One line the bot keeps current. Empty until its first update ("Waiting for <bot>"). */
  headline: Schema.String,
  headlineAt: Schema.NullOr(IsoDateTime),
  /** PR numbers its sessions opened, for chips. */
  pullRequests: Schema.Array(
    Schema.Struct({ number: PositiveInt, url: Schema.String, state: Schema.String }),
  ),
  report: Schema.NullOr(BotJobReport),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type BotJob = typeof BotJob.Type;

export const BotSessionRole = Schema.Literals(["worker", "reviewer"]);
export type BotSessionRole = typeof BotSessionRole.Type;

/**
 * A thread the bot started for a job. Its live state (working, waiting, done, failed, paused until,
 * quiet) is derived on the client from the thread shell it already has.
 */
export const BotSession = Schema.Struct({
  threadId: ThreadId,
  botId: BotId,
  jobId: BotJobId,
  role: BotSessionRole,
  title: TrimmedNonEmptyString,
  projectId: ProjectId,
  /** The user typed into it, so the bot stopped steering it until Hand back. */
  takenOver: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type BotSession = typeof BotSession.Type;

export const BotAskStatus = Schema.Literals(["open", "answered"]);
export type BotAskStatus = typeof BotAskStatus.Type;

/** How an Ask was answered: a suggestion, the user's own words, or "Let <bot> decide". */
export const BotAnswerKind = Schema.Literals(["option", "text", "bot-decides"]);
export type BotAnswerKind = typeof BotAnswerKind.Type;

export const BotAsk = Schema.Struct({
  id: BotAskId,
  botId: BotId,
  jobId: Schema.NullOr(BotJobId),
  question: TrimmedNonEmptyString,
  /** Shown clamped to two lines. */
  why: Schema.String,
  /** Up to three suggested answers. */
  options: Schema.Array(Schema.String),
  /** The suggestion the bot would pick, if any. Shown as a neutral label. */
  pick: Schema.NullOr(Schema.String),
  status: BotAskStatus,
  answerKind: Schema.NullOr(BotAnswerKind),
  answer: Schema.NullOr(Schema.String),
  /** The user asked the bot to remember this answer; `noteId` is set once it saved the note. */
  remember: Schema.Boolean,
  noteId: Schema.NullOr(BotNoteId),
  createdAt: IsoDateTime,
  answeredAt: Schema.NullOr(IsoDateTime),
});
export type BotAsk = typeof BotAsk.Type;

export const BotNote = Schema.Struct({
  id: BotNoteId,
  botId: BotId,
  text: TrimmedNonEmptyString,
  /** e.g. "From your answer on J-11", "From Chat". */
  source: Schema.String,
  sourceJobId: Schema.NullOr(BotJobId),
  /** How many decisions cited it. */
  citedCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BotNote = typeof BotNote.Type;

/** Timeline rows. A `decision` is a session question the bot answered for you. */
export const BotEventKind = Schema.Literals([
  "decision",
  "session-started",
  "session-finished",
  "session-failed",
  "session-quiet",
  "session-taken-over",
  "session-handed-back",
  "asked",
  "answered",
  "note-saved",
  "job-started",
  "job-done",
  "job-stopped",
  "job-reopened",
  "correction",
  "info",
]);
export type BotEventKind = typeof BotEventKind.Type;

export const BotDecision = Schema.Struct({
  /** The session's title, e.g. "Upgrade server". */
  sessionTitle: Schema.String,
  question: Schema.String,
  answer: Schema.String,
  /** The playbook line or note it relied on, e.g. `Note: "Fix the cause, not the symptom"`. */
  cite: Schema.String,
  noteId: Schema.NullOr(BotNoteId),
  requestId: Schema.NullOr(RuntimeRequestId),
  /** The user's correction, once they sent one. */
  correction: Schema.NullOr(Schema.String),
});
export type BotDecision = typeof BotDecision.Type;

export const BotEvent = Schema.Struct({
  id: BotEventId,
  botId: BotId,
  jobId: Schema.NullOr(BotJobId),
  kind: BotEventKind,
  /** One plain line for the timeline. */
  text: Schema.String,
  sessionThreadId: Schema.NullOr(ThreadId),
  decision: Schema.NullOr(BotDecision),
  createdAt: IsoDateTime,
});
export type BotEvent = typeof BotEvent.Type;

/** Everything the bot pages show, for every bot the caller owns. Small, so it is sent whole. */
export const BotsSnapshot = Schema.Struct({
  bots: Schema.Array(Bot),
  jobs: Schema.Array(BotJob),
  sessions: Schema.Array(BotSession),
  asks: Schema.Array(BotAsk),
  notes: Schema.Array(BotNote),
  /** The most recent events per bot (up to `BOT_EVENTS_PER_BOT`), newest first. */
  events: Schema.Array(BotEvent),
  /** Bumped on every change. */
  revision: NonNegativeInt,
});
export type BotsSnapshot = typeof BotsSnapshot.Type;

export const BOT_EVENTS_PER_BOT = 300;
/** A session request the bot hasn't answered for this long goes to your Inbox. */
export const BOT_ESCALATE_AFTER_MS = 10 * 60_000;
/** A working session with no new output for this long is "quiet", and the bot is woken once. */
export const BOT_QUIET_AFTER_MS = 30 * 60_000;
/** Wakes this close together are sent to the home thread as one message. */
export const BOT_WAKE_BATCH_MS = 3_000;

// ---------- RPC inputs ----------

export const BotsCreateInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  charter: Schema.String,
  starter: BotStarter,
  models: Schema.optionalKey(BotModels),
});
export type BotsCreateInput = typeof BotsCreateInput.Type;

export const BotsUpdateInput = Schema.Struct({
  botId: BotId,
  name: Schema.optionalKey(TrimmedNonEmptyString),
  charter: Schema.optionalKey(Schema.String),
  instructions: Schema.optionalKey(Schema.String),
  limits: Schema.optionalKey(Schema.Array(BotLimit)),
  models: Schema.optionalKey(BotModels),
});
export type BotsUpdateInput = typeof BotsUpdateInput.Type;

export const BotsBotInput = Schema.Struct({ botId: BotId });
export type BotsBotInput = typeof BotsBotInput.Type;

export const BotsCreateJobInput = Schema.Struct({
  botId: BotId,
  request: TrimmedNonEmptyString,
  projectId: Schema.optionalKey(ProjectId),
});
export type BotsCreateJobInput = typeof BotsCreateJobInput.Type;

export const BotsJobInput = Schema.Struct({ jobId: BotJobId });
export type BotsJobInput = typeof BotsJobInput.Type;

export const BotsAnswerAskInput = Schema.Struct({
  askId: BotAskId,
  kind: BotAnswerKind,
  /** Required unless `kind` is `bot-decides`. */
  answer: Schema.optionalKey(Schema.String),
  remember: Schema.Boolean,
});
export type BotsAnswerAskInput = typeof BotsAnswerAskInput.Type;

export const BotsAskInput = Schema.Struct({ askId: BotAskId });
export type BotsAskInput = typeof BotsAskInput.Type;

export const BotsCorrectDecisionInput = Schema.Struct({
  eventId: BotEventId,
  correction: TrimmedNonEmptyString,
});
export type BotsCorrectDecisionInput = typeof BotsCorrectDecisionInput.Type;

export const BotsSessionInput = Schema.Struct({ threadId: ThreadId });
export type BotsSessionInput = typeof BotsSessionInput.Type;

export const BotsUpdateNoteInput = Schema.Struct({
  noteId: BotNoteId,
  text: TrimmedNonEmptyString,
});
export type BotsUpdateNoteInput = typeof BotsUpdateNoteInput.Type;

export const BotsNoteInput = Schema.Struct({ noteId: BotNoteId });
export type BotsNoteInput = typeof BotsNoteInput.Type;

export class BotsError extends Schema.TaggedError<BotsError>()("BotsError", {
  reason: Schema.Literals(["not-found", "invalid-request", "unavailable", "cloud-only"]),
  message: Schema.String,
}) {}
