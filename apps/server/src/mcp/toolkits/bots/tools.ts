import {
  BotAskId,
  BotJob,
  BotJobStatus,
  BotNoteId,
  BotSessionRole,
  EnvironmentId,
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
  takenOver: Schema.Boolean,
  status: Schema.String,
  pendingRequest: Schema.NullOr(
    Schema.Struct({
      requestId: RuntimeRequestId,
      kind: Schema.String,
      text: Schema.String,
    }),
  ),
  lastAssistantText: Schema.NullOr(Schema.String),
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
});

const BriefResult = Schema.Struct({
  bot: Schema.Struct({
    name: Schema.String,
    charter: Schema.String,
    /** How to sound in this chat, e.g. "Crisp: results first, in the fewest words." */
    voice: Schema.String,
    paused: Schema.Boolean,
  }),
  playbook: Schema.Struct({
    instructions: Schema.String,
    checkWithMeBefore: Schema.Array(Schema.String),
    notes: Schema.Array(
      Schema.Struct({
        noteId: BotNoteId,
        text: Schema.String,
        source: Schema.String,
        citedCount: NonNegativeInt,
      }),
    ),
  }),
  projects: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      title: Schema.String,
      workspaceRoot: Schema.String,
    }),
  ),
  /** Where `bot_start_session` with `cloud` runs, or why it can't. */
  cloud: Schema.Union([
    Schema.Struct({ environmentId: Schema.NullOr(EnvironmentId), label: Schema.String }),
    Schema.Struct({ unavailable: Schema.String }),
  ]),
  jobs: Schema.Array(BriefJob),
  openAsks: Schema.Array(
    Schema.Struct({
      askId: BotAskId,
      jobId: Schema.NullOr(BotJob.fields.id),
      question: Schema.String,
      options: Schema.Array(Schema.String),
      pick: Schema.NullOr(Schema.String),
    }),
  ),
});

const BotBriefTool = Tool.make("bot_brief", {
  ...shared,
  description:
    "Read your playbook, the projects you can work in, every job with its sessions' live state, and your open Asks. Call this first whenever a job is involved.",
  parameters: Tool.EmptyParams,
  success: BriefResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForBots);

const JobUpdateTool = Tool.make("bot_job_update", {
  ...shared,
  description:
    "Keep a job's one-line headline current, or finish it with status done and a report. A report is required when you finish a job. Set archived to true to clear a finished job from the user's sidebar, only when they ask; false brings it back.",
  parameters: Schema.Struct({
    jobId: BotJob.fields.id,
    headline: Schema.optional(Schema.String),
    title: Schema.optional(TrimmedNonEmptyString),
    status: Schema.optional(Schema.Literal("done")),
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
    "Start a session that does a job's work. It runs in the job's project unless you give projectId: a git project gets a new worktree; a job with no project runs in a scratch folder on this machine, with full access. Use role worker for doing the work and reviewer for review. Put the returned link in your reply exactly as given. Pass cloud to run it on a Pair Cloud machine (bot_brief's cloud) that keeps going when this computer sleeps; it starts from the pushed baseRef, so unpushed local edits are not there. A cloud machine spends money: use cloud only when the user asked for it, your instructions say when to, or spending money is not in your check-with-me list; otherwise ask first with bot_ask.",
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
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    link: Schema.String,
    /** "this machine", or the Pair Cloud's label. */
    where: Schema.String,
    environmentId: Schema.optional(EnvironmentId),
  }),
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForBots);

const SessionMessageTool = Tool.make("bot_session_message", {
  ...shared,
  description:
    "Send a message to a session you started, to steer it or ask for a status. Refuses sessions the user took over.",
  parameters: Schema.Struct({
    threadId: ThreadId,
    text: Schema.String,
  }),
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
  description:
    "Save one short, general rule to your playbook. Pass the askId when it came from an Ask, or omit it when the user said it in Chat.",
  parameters: Schema.Struct({
    text: Schema.String,
    askId: Schema.optional(BotAskId),
    source: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({ noteId: BotNoteId }),
})
  .annotate(Tool.Destructive, true)
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
  SessionRespondTool,
  AskTool,
  AskResolveTool,
  LearnTool,
  ForgetTool,
);
