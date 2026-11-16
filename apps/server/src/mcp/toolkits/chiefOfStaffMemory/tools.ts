import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ChiefOfStaffMemory from "../../../chiefOfStaff/ChiefOfStaffMemory.ts";
import { ServerConfig } from "../../../config.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ChiefOfStaffMemory.ChiefOfStaffMemory,
    ThreadManagementService.ThreadManagementService,
    ServerConfig,
    FileSystem.FileSystem,
    Path.Path,
  ],
};

const MemoryReadTool = Tool.make("cos_memory_read", {
  ...shared,
  description:
    "Read your durable memory blocks with their sizes and limits. Read this before answering anything about the user.",
  parameters: Tool.EmptyParams,
  success: ChiefOfStaffMemory.MemorySnapshot,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromSubagents);

const MemoryUpdateTool = Tool.make("cos_memory_update", {
  ...shared,
  description:
    "Store durable facts the user would want remembered. Keep blocks curated; prefer `replace` over `append`, and condense a block before it hits its limit.",
  parameters: Schema.Struct({
    label: ChiefOfStaffMemory.MemoryBlockLabel,
    op: Schema.Literals(["replace", "append", "set"]),
    old_text: Schema.optional(Schema.String),
    text: Schema.String,
  }),
  success: ChiefOfStaffMemory.MemoryBlock,
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromSubagents);

const MemoryHistoryTool = Tool.make("cos_memory_history", {
  ...shared,
  description:
    "List recent changes to your memory, newest first, to see what was added or edited and by whom.",
  parameters: Schema.Struct({
    label: Schema.optional(ChiefOfStaffMemory.MemoryBlockLabel),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  }),
  success: Schema.Struct({ entries: Schema.Array(ChiefOfStaffMemory.MemoryHistoryEntry) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromSubagents);

export const ChiefOfStaffMemoryToolkit = Toolkit.make(
  MemoryReadTool,
  MemoryUpdateTool,
  MemoryHistoryTool,
);
