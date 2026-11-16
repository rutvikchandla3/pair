import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ChiefOfStaffAudit from "../../../chiefOfStaff/ChiefOfStaffAudit.ts";
import { chiefOfStaffCaller } from "../../../chiefOfStaff/caller.ts";
import { readHomeThreads } from "../../../chiefOfStaff/homeThreads.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ChiefOfStaffAuditToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ChiefOfStaffAuditToolkit, {
  cos_audit_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const caller = chiefOfStaffCaller(scope, yield* readHomeThreads);
      if (caller === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only Chief of staff may read its own tool-call audit log.",
        });
      }
      const audit = yield* ChiefOfStaffAudit.ChiefOfStaffAudit;
      const entries = yield* audit.recent({
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.tool === undefined ? {} : { tool: input.tool }),
      });
      return { entries };
    }),
  ),
});
