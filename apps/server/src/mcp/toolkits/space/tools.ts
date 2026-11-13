import {
  MemberId,
  MessageId,
  OrchestratorMcpFailure,
  SpaceBrief,
  SpaceId,
  SpaceMention,
  SpaceMutation,
  SpaceName,
  SpaceRoomEntry,
  SpaceTaskDescription,
  SpaceTaskId,
  SpaceTaskStatus,
  SpaceTaskTitle,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SpaceService from "../../../space/SpaceService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    SpaceService.SpaceService,
    SecureRandom.SecureRandom,
  ],
};

const SpaceSummary = Schema.Struct({
  spaceId: SpaceId,
  name: SpaceName,
  archived: Schema.Boolean,
});

const SpaceTaskSummary = Schema.Struct({
  taskId: SpaceTaskId,
  title: Schema.String,
  ownerId: MemberId,
  /** todo, in-progress, in-review, done or canceled: set by people, never by a turn ending. */
  status: SpaceTaskStatus,
  threads: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      title: Schema.String,
      ownerId: Schema.NullOr(MemberId),
      /** working, needs-answer, needs-approval, failed, limited, stopped or idle. */
      activity: Schema.String,
    }),
  ),
});

const SpaceReadTool = Tool.make("t3_space_read", {
  ...shared,
  description:
    "Read your spaces (shared team rooms with a brief and tasks). Without `spaceId`, lists them; with it, returns the brief, members, recent room posts, and every task with its status and its threads' activity.",
  parameters: Schema.Struct({ spaceId: Schema.optionalKey(SpaceId) }),
  success: Schema.Union([
    Schema.Struct({ spaces: Schema.Array(SpaceSummary) }),
    Schema.Struct({
      space: Schema.Struct({
        spaceId: SpaceId,
        name: SpaceName,
        brief: SpaceBrief,
        ownerId: MemberId,
        memberIds: Schema.Array(MemberId),
        archived: Schema.Boolean,
      }),
      entries: Schema.Array(SpaceRoomEntry),
      tasks: Schema.Array(SpaceTaskSummary),
    }),
  ]),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const SpacePostTool = Tool.make("t3_space_post", {
  ...shared,
  description:
    "Post to a space's room as your member. Mention members with `mentions`; an agent's post never asks @pair to reply.",
  parameters: Schema.Struct({
    spaceId: SpaceId,
    text: TrimmedNonEmptyString,
    mentions: Schema.optionalKey(Schema.Array(SpaceMention)),
    quoteEntryId: Schema.optionalKey(MessageId),
  }),
  success: Schema.Struct({ entryId: MessageId }),
}).annotate(Tool.Destructive, false);

const SpaceTaskCreateTool = Tool.make("t3_space_task_create", {
  ...shared,
  description:
    "Create a task in a space, assigned to `ownerId` (you by default), at To do unless `status` says otherwise. It starts no thread.",
  parameters: Schema.Struct({
    spaceId: SpaceId,
    title: SpaceTaskTitle,
    description: SpaceTaskDescription,
    ownerId: Schema.optionalKey(MemberId),
    status: Schema.optionalKey(SpaceTaskStatus),
  }),
  success: Schema.Struct({ taskId: SpaceTaskId }),
}).annotate(Tool.Destructive, false);

const SpaceThreadStartTool = Tool.make("t3_space_thread_start", {
  ...shared,
  description:
    "Start a thread on one of your spaces' open tasks, on your own account, in the space's repositories. Its first message is `prompt`, or the task's description. It doesn't change the task's status.",
  parameters: Schema.Struct({
    taskId: SpaceTaskId,
    prompt: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({ threadId: ThreadId }),
}).annotate(Tool.Destructive, false);

const SpaceTaskStatusTool = Tool.make("t3_space_task_status", {
  ...shared,
  description:
    "Set the status of the space task this thread is on. Call it only when the user explicitly asks " +
    'you to change the task\'s status in this turn (for example "move this to In review"). Finishing ' +
    "the work, passing tests, opening or merging a pull request, or ending your turn is never a reason " +
    "to call it. Statuses: todo, in-progress, in-review, done, canceled.",
  parameters: Schema.Struct({ status: SpaceTaskStatus }),
  success: Schema.Struct({
    taskId: SpaceTaskId,
    title: Schema.String,
    from: SpaceTaskStatus,
    to: SpaceTaskStatus,
  }),
})
  .annotate(Tool.Title, "Set task status")
  .annotate(Tool.Destructive, false);

const SpaceManageTool = Tool.make("t3_space_manage", {
  ...shared,
  description:
    "Create, edit, archive or leave a space, change its members or owner, or ask to join one. Only the owner may edit, archive, or change members and owner.",
  parameters: Schema.Struct({ action: SpaceMutation }),
  /** Null after you leave. */
  success: Schema.Struct({ space: Schema.NullOr(SpaceSummary) }),
}).annotate(Tool.Destructive, false);

export const SpaceToolkit = Toolkit.make(
  SpaceReadTool,
  SpacePostTool,
  SpaceTaskCreateTool,
  SpaceThreadStartTool,
  SpaceTaskStatusTool,
  SpaceManageTool,
);
