import {
  MemberId,
  MessageId,
  ModelSelection,
  OrchestratorMcpFailure,
  SpaceBrief,
  SpaceId,
  SpaceMention,
  SpaceMutation,
  SpaceName,
  SpaceRoomEntry,
  SpaceTaskBase,
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
  threadId: ThreadId,
  title: Schema.String,
  ownerId: Schema.NullOr(MemberId),
  /** not-started, working, needs-answer, needs-approval, failed, limited, stopped, in-review, done. */
  status: Schema.String,
});

const SpaceReadTool = Tool.make("t3_space_read", {
  ...shared,
  description:
    "Read your spaces (shared team rooms with a brief and tasks). Without `spaceId`, lists them; with it, returns the brief, members, recent room posts and every task's status.",
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
    "Create a task in a space: a cloud thread owned by `ownerId`. Your own task starts now; someone else's waits until they start it.",
  parameters: Schema.Struct({
    spaceId: SpaceId,
    title: TrimmedNonEmptyString,
    description: TrimmedNonEmptyString,
    ownerId: MemberId,
    modelSelection: ModelSelection,
    base: SpaceTaskBase,
  }),
  success: Schema.Struct({ threadId: ThreadId, started: Schema.Boolean }),
}).annotate(Tool.Destructive, false);

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
  SpaceManageTool,
);
