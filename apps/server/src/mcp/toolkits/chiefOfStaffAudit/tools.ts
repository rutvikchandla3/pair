import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ChiefOfStaffAudit from "../../../chiefOfStaff/ChiefOfStaffAudit.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext, ChiefOfStaffAudit.ChiefOfStaffAudit],
};

const ChiefOfStaffAuditReadTool = Tool.make("cos_audit_read", {
  ...shared,
  description:
    "Read the newest Chief of staff tool calls, newest first. Only Chief of staff callers may use it.",
  parameters: Schema.Struct({
    limit: Schema.optional(Schema.Int),
    tool: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({ entries: Schema.Array(ChiefOfStaffAudit.AuditEntrySchema) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForChiefOfStaff);

export const ChiefOfStaffAuditToolkit = Toolkit.make(ChiefOfStaffAuditReadTool);
