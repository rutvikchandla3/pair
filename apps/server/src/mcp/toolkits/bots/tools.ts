import {
  BotAskId,
  BotJob,
  BotJobStatus,
  BotNoteId,
  BotSessionRole,
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
    "Keep a job's one-line headline current, or finish it with status done and a report. A report is required when you finish a job.",
  parameters: Schema.Struct({
    jobId: BotJob.fields.id,
    headline: Schema.optional(Schema.String),
    title: Schema.optional(TrimmedNonEmptyString),
    status: Schema.optional(Schema.Literal("done")),
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
    "Create a job for one independent piece of the user's request. Give it a short title, the request in full, and the project it should run in.",
  parameters: Schema.Struct({
    title: TrimmedNonEmptyString,
    request: Schema.String,
    projectId: ProjectId,
  }),
  success: Schema.Struct({ jobId: BotJob.fields.id, title: Schema.String }),
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForBots);

const StartSessionTool = Tool.make("bot_start_session", {
  ...shared,
  description:
    "Start a coding session for a job in one of its projects, in a new worktree. Use role worker for implementation and reviewer for review. Put the returned link in your reply exactly as given.",
  parameters: Schema.Struct({
    jobId: BotJob.fields.id,
    projectId: ProjectId,
    role: BotSessionRole,
    title: TrimmedNonEmptyString,
    task: Schema.String,
  }),
  success: Schema.Struct({ threadId: ThreadId, link: Schema.String }),
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
