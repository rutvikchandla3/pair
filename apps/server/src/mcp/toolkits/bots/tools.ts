import {
  BotAskId,
  BotJob,
  BotJobStatus,
  BotNoteId,
  BotSessionRole,
  EnvironmentId,
  ModelSelection,
  NonNegativeInt,
  OrchestratorMcpFailure,
  PositiveInt,
  ProjectId,
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as McpSchema from "effect/ai/McpSchema";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as BotSessions from "../../../bots/BotSessions.ts";
import * as BotService from "../../../bots/BotService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    BotService.BotService,
    BotSessions.BotSessions,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
  ],
};

const SessionLiveState = Schema.Struct({
  threadId: ThreadId,
  role: BotSessionRole,
  title: Schema.String,
  /** "this machine", or the Pair Cloud's label. */
  where: Schema.String,
  /** Present for a cloud session: pass it to t3_thread_read. */
  environmentId: Schema.optional(EnvironmentId),
  /** False while its cloud can't be reached; its state is then the last one read. */
  reachable: Schema.Boolean,
  /** What it runs on; null for sessions started before it was recorded. */
  modelSelection: Schema.NullOr(ModelSelection),
  takenOver: Schema.Boolean,
  status: Schema.String,
  pendingRequest: Schema.NullOr(
    Schema.Struct({
      requestId: RuntimeRequestId,
      kind: Schema.String,
      text: Schema.String,
    }),
  ),
  /** The start of its last message, once its run ended and only when it changed. */
  lastAssistantText: Schema.NullOr(Schema.String),
});

const ChatAttachmentReferences = Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(4096)))
  .check(Schema.isMaxLength(8))
  .annotate({
    description:
      "Images or files the user attached in this chat, each by its attachment id or saved path. Never their contents.",
  });

const BriefJob = Schema.Struct({
  jobId: BotJob.fields.id,
  number: PositiveInt,
  title: Schema.String,
  request: Schema.String,
  projectId: Schema.NullOr(ProjectId),
  status: BotJobStatus,
  headline: Schema.String,
  pullRequests: BotJob.fields.pullRequests,
  sessions: Schema.Array(SessionLiveState),
  /** Older sessions left out. */
  moreSessions: NonNegativeInt,
});

const BriefResult = Schema.Struct({
  /** Pass it as `since` next time to read only what changed. */
  asOf: Schema.String,
  /** The `since` this brief answers; null for the whole brief. */
  since: Schema.NullOr(Schema.String),
  /** Null when `since` is given: it changes only with a whole brief. */
  bot: Schema.NullOr(
    Schema.Struct({
      name: Schema.String,
      charter: Schema.String,
      /** How to sound in this chat, e.g. "Crisp: results first, in the fewest words." */
      voice: Schema.String,
      paused: Schema.Boolean,
      /** Each role's default; this machine's instance ids. */
      models: Schema.Struct({ worker: ModelSelection, reviewer: ModelSelection }),
    }),
  ),
  playbook: Schema.Struct({
    /** Null when `since` is given. */
    instructions: Schema.NullOr(Schema.String),
    checkWithMeBefore: Schema.Array(Schema.String),
    notes: Schema.Array(
      Schema.Struct({
        noteId: BotNoteId,
        text: Schema.String,
        source: Schema.String,
        citedCount: NonNegativeInt,
      }),
    ),
    /** Notes left out: unchanged since `since`, or past the brief's size. */
    moreNotes: NonNegativeInt,
  }),
  /** Null when `since` is given. */
  projects: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        projectId: ProjectId,
        title: Schema.String,
        workspaceRoot: Schema.String,
      }),
    ),
  ),
  /** Where `bot_start_session` with `cloud` runs, or why it can't. */
  cloud: Schema.Union([
    Schema.Struct({ environmentId: Schema.NullOr(EnvironmentId), label: Schema.String }),
    Schema.Struct({ unavailable: Schema.String }),
  ]),
  /** Open jobs, most recently changed first. */
  jobs: Schema.Array(BriefJob),
  /** Open jobs past the brief's size, named only. */
  otherOpenJobs: Schema.Array(Schema.Struct({ jobId: BotJob.fields.id, title: Schema.String })),
  /** Open jobs not listed at all: unchanged since `since`, or past the brief's size. */
  moreJobs: NonNegativeInt,
  finishedJobs: Schema.Array(
    Schema.Struct({
      jobId: BotJob.fields.id,
      title: Schema.String,
      status: BotJobStatus,
      finishedAt: Schema.NullOr(Schema.String),
      headline: Schema.String,
      pullRequests: BotJob.fields.pullRequests,
      /** The start of its report's "what changed". */
      report: Schema.NullOr(Schema.String),
    }),
  ),
  openAsks: Schema.Array(
    Schema.Struct({
      askId: BotAskId,
      jobId: Schema.NullOr(BotJob.fields.id),
      question: Schema.String,
      options: Schema.Array(Schema.String),
      pick: Schema.NullOr(Schema.String),
    }),
  ),
  /** Open Asks past the brief's size, newest shown first. */
  moreAsks: NonNegativeInt,
  /** The user's latest answers to your Asks, newest first; bot_recall finds older ones. */
  recentAnswers: Schema.Array(
    Schema.Struct({
      askId: BotAskId,
      jobId: Schema.NullOr(BotJob.fields.id),
      question: Schema.String,
      /** Null when they let you decide. */
      answer: Schema.NullOr(Schema.String),
      answeredAt: Schema.NullOr(Schema.String),
    }),
  ),
});

const BotBriefTool = Tool.make("bot_brief", {
  ...shared,
  description:
    "Read your playbook, the projects you can work in, your open jobs with their sessions' live state, recently finished jobs, and your open Asks. Pass since (the asOf of the last brief you read in this chat) to get only what changed after it.",
  parameters: Schema.Struct({
    since: Schema.optional(
      Schema.String.annotate({ description: "The asOf of an earlier brief in this chat." }),
    ),
  }),
  success: BriefResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForBots);

const JobUpdateTool = Tool.make("bot_job_update", {
  ...shared,
  description:
    "Keep a job's one-line headline current, or finish it with status done and a report. A report is required when you finish a job. Set archived to true to clear a finished job from the user's sidebar, only when they ask; false brings it back. Status working reopens a job you finished; a job the user stopped stays stopped.",
  parameters: Schema.Struct({
    jobId: BotJob.fields.id,
    headline: Schema.optional(Schema.String),
    title: Schema.optional(TrimmedNonEmptyString),
    status: Schema.optional(Schema.Literals(["done", "working"])),
    archived: Schema.optional(Schema.Boolean),
    report: Schema.optional(
      Schema.Struct({
        changed: Schema.String,
        evidence: Schema.Array(Schema.String),
        openQuestions: Schema.Array(Schema.String),
        next: Schema.optional(
          Schema.Struct({
            text: Schema.String,
            suggestedRequest: Schema.optional(Schema.String),
          }),
        ),
      }),
    ),
  }),
  success: BotJob,
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForBots);

const JobCreateTool = Tool.make("bot_job_create", {
  ...shared,
  description:
    "Create a job for one independent piece of the user's request. Give it a short title, the request in full, and the project it should run in. Leave out projectId for work outside any project, such as this machine's config files, a database, or a website.",
  parameters: Schema.Struct({
    title: TrimmedNonEmptyString,
    request: Schema.String,
    projectId: Schema.optional(ProjectId),
  }),
  success: Schema.Struct({ jobId: BotJob.fields.id, title: Schema.String }),
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForBots);

const StartSessionTool = Tool.make("bot_start_session", {
  ...shared,
  description:
    "Start a session that does a job's work. It runs in the job's project unless you give projectId: a git project gets a new worktree; a job with no project runs in a scratch folder on this machine, with full access. Use role worker for doing the work and reviewer for review. Put the returned link in your reply exactly as given. Pass cloud to run it on a Pair Cloud machine (bot_brief's cloud) that keeps going when this computer sleeps; it starts from the pushed baseRef, so unpushed local edits are not there. A cloud machine spends money: use cloud only when the user asked for it, your instructions say when to, or spending money is not in your check-with-me list; otherwise ask first with bot_ask. Pass modelSelection when the user names a provider, model or effort; get the ids from orchestrator_capabilities (with bot_brief's cloud.environmentId for a cloud session, left out when it is null). When the user attached screenshots or files the session needs, pass them in attachments: the session gets them as its own, in the cloud too.",
  parameters: Schema.Struct({
    jobId: BotJob.fields.id,
    projectId: Schema.optional(ProjectId),
    role: BotSessionRole,
    title: TrimmedNonEmptyString,
    task: Schema.String,
    cloud: Schema.optional(
      Schema.Struct({
        environmentId: Schema.optional(
          EnvironmentId.annotate({ description: "Only when several Pair Clouds are linked." }),
        ),
        baseRef: Schema.optional(
          TrimmedNonEmptyString.annotate({
            description: "Pushed branch, tag or commit. Default: the project's default branch.",
          }),
        ),
        branch: Schema.optional(
          TrimmedNonEmptyString.annotate({ description: "New branch name for the checkout." }),
        ),
      }),
    ),
    modelSelection: Schema.optional(
      ModelSelection.annotate({
        description:
          "Instead of your role's model, e.g. effort is options [{ id: 'effort', value: 'xhigh' }].",
      }),
    ),
    attachments: Schema.optional(ChatAttachmentReferences),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    link: Schema.String,
    /** "this machine", or the Pair Cloud's label. */
    where: Schema.String,
    environmentId: Schema.optional(EnvironmentId),
    /** What it runs on. */
    modelSelection: Schema.optional(ModelSelection),
  }),
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForBots);

const SessionMessageTool = Tool.make("bot_session_message", {
  ...shared,
  description:
    "Send a message to a session you started, to steer it or ask for a status. Pass attachments to give it screenshots or files the user attached in this chat. Refuses sessions the user took over.",
  parameters: Schema.Struct({
    threadId: ThreadId,
    text: Schema.String,
    attachments: Schema.optional(ChatAttachmentReferences),
  }),
  success: Schema.Struct({ ok: Schema.Literal(true) }),
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForBots);

const SessionReclaimTool = Tool.make("bot_session_reclaim", {
  ...shared,
  description:
    "Take back a session the user took over, when they hand it back to you in this chat ('hand it back'). Then read what changed with t3_thread_read and continue it.",
  parameters: Schema.Struct({ threadId: ThreadId }),
  success: Schema.Struct({ ok: Schema.Literal(true) }),
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForBots);

const SessionRespondTool = Tool.make("bot_session_respond", {
  ...shared,
  description:
    "Answer a session's pending question or approval when your playbook covers it, quoting what you relied on in cite. Refuses sessions the user took over.",
  parameters: Schema.Struct({
    threadId: ThreadId,
    requestId: RuntimeRequestId,
    decision: Schema.optional(ProviderApprovalDecision),
    answers: Schema.optional(ProviderUserInputAnswers),
    feedback: Schema.optional(Schema.String),
    question: Schema.String,
    answer: Schema.String,
    cite: Schema.String,
    noteId: Schema.optional(BotNoteId),
  }),
  success: Schema.Struct({ ok: Schema.Literal(true) }),
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForBots);

const AskTool = Tool.make("bot_ask", {
  ...shared,
  description:
    "Ask the user a question you cannot decide from the playbook. Pass the job's `jobId` whenever the question is about a job, even before it has a session: Pair names the question after that work. Give up to three suggested answers and the one you would pick.",
  parameters: Schema.Struct({
    jobId: Schema.optional(BotJob.fields.id),
    question: Schema.String,
    why: Schema.String,
    options: Schema.Array(Schema.String),
    pick: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({ askId: BotAskId }),
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForBots);

const AskResolveTool = Tool.make("bot_ask_resolve", {
  ...shared,
  description:
    "Record the user's answer to an Ask when they answered in Chat. Set decidedByYou when they let you decide.",
  parameters: Schema.Struct({
    askId: BotAskId,
    answer: Schema.String,
    decidedByYou: Schema.Boolean,
  }),
  success: Schema.Struct({ ok: Schema.Literal(true) }),
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForBots);

const LearnTool = Tool.make("bot_learn", {
  ...shared,
  description: `Save one short, general rule to your playbook, at most ${BotService.NOTE_MAX_CHARS} characters; save each rule on its own. Saving a rule you already have returns its noteId. To correct a note, bot_forget it and save the new rule. Pass the askId when it came from an Ask, or omit it when the user said it in Chat.`,
  parameters: Schema.Struct({
    text: Schema.String.check(Schema.isMaxLength(BotService.NOTE_MAX_CHARS)),
    askId: Schema.optional(BotAskId),
    source: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({
    noteId: BotNoteId,
    /** Set when you hold more notes than the playbook should: merge or forget some. */
    overLimit: Schema.optional(Schema.Literal(true)),
  }),
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForBots);

const RecallTool = Tool.make("bot_recall", {
  ...shared,
  dependencies: [...shared.dependencies, ThreadSearch.ThreadSearch],
  description:
    "Search what bot_brief no longer shows: this chat's earlier messages, every job's request and report, the user's answers to your Asks, and all your notes. Use it before you tell the user you don't know or don't remember.",
  parameters: Schema.Struct({
    query: TrimmedNonEmptyString.check(Schema.isMinLength(2), Schema.isMaxLength(200)),
    limit: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })).annotate({
        description: "Default 8.",
      }),
    ),
  }),
  success: Schema.Struct({
    results: Schema.Array(
      Schema.Union([
        Schema.Struct({
          source: Schema.Literal("chat"),
          /** Who wrote it: the user, or you. */
          from: Schema.Literals(["user", "you"]),
          at: Schema.NullOr(Schema.String),
          text: Schema.String,
        }),
        Schema.Struct({
          source: Schema.Literal("job"),
          jobId: BotJob.fields.id,
          title: Schema.String,
          at: Schema.NullOr(Schema.String),
          text: Schema.String,
        }),
        Schema.Struct({
          source: Schema.Literal("answer"),
          askId: BotAskId,
          jobId: Schema.NullOr(BotJob.fields.id),
          at: Schema.NullOr(Schema.String),
          text: Schema.String,
        }),
        Schema.Struct({
          source: Schema.Literal("note"),
          noteId: BotNoteId,
          at: Schema.NullOr(Schema.String),
          text: Schema.String,
        }),
      ]),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForBots);

const ForgetTool = Tool.make("bot_forget", {
  ...shared,
  description:
    "Forget a note you saved from your playbook. Use it when the user says to forget what you learned.",
  parameters: Schema.Struct({ noteId: BotNoteId }),
  success: Schema.Struct({ forgotten: Schema.Literal(true), text: Schema.String }),
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForBots);

export const BotsToolkit = Toolkit.make(
  BotBriefTool,
  JobCreateTool,
  JobUpdateTool,
  StartSessionTool,
  SessionMessageTool,
  SessionReclaimTool,
  SessionRespondTool,
  AskTool,
  AskResolveTool,
  LearnTool,
  ForgetTool,
  RecallTool,
);
