import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ChiefOfStaffMemory from "../../../chiefOfStaff/ChiefOfStaffMemory.ts";
import { loadHomeThreads } from "../../../chiefOfStaff/homeThreads.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { ChiefOfStaffMemoryToolkit } from "./tools.ts";

const accessDenied = new OrchestratorMcpFailure({
  code: "capability_denied",
  message:
    "These tools are only for Chief of staff: a caller must be one of its home threads, or an MCP client whose member has one.",
});

/** Whichever home thread this caller is: its own, or the one its member owns. */
const resolveMemberId = Effect.fn("chiefOfStaffMemory.resolveMemberId")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const homeThreads = yield* loadHomeThreads;
  const fromThread =
    scope.thread === undefined ? undefined : homeThreads.memberIdForThread(scope.thread.threadId);
  if (fromThread !== undefined) return fromThread;
  const memberId = scope.client?.memberId;
  if (memberId !== undefined && homeThreads.hasHomeThread(memberId)) return memberId;
  return yield* accessDenied;
});

const memoryFailure = (error: ChiefOfStaffMemory.ChiefOfStaffMemoryError) =>
  error.reason === "io_failed"
    ? unavailable()
    : new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

export const layer = McpToolAccess.toLayer(ChiefOfStaffMemoryToolkit, {
  cos_memory_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const memberId = yield* resolveMemberId();
      const memory = yield* ChiefOfStaffMemory.ChiefOfStaffMemory;
      return yield* memory.read(memberId).pipe(Effect.mapError(memoryFailure));
    }),
  ),
  cos_memory_update: McpToolAccess.writes((params) =>
    Effect.gen(function* () {
      const memberId = yield* resolveMemberId();
      const memory = yield* ChiefOfStaffMemory.ChiefOfStaffMemory;
      const change: ChiefOfStaffMemory.MemoryUpdate = {
        label: params.label,
        op: params.op,
        ...(params.old_text === undefined ? {} : { oldText: params.old_text }),
        text: params.text,
      };
      return yield* memory
        .update(memberId, change, "chief-of-staff")
        .pipe(Effect.mapError(memoryFailure));
    }),
  ),
  cos_memory_history: McpToolAccess.reads((params) =>
    Effect.gen(function* () {
      const memberId = yield* resolveMemberId();
      const memory = yield* ChiefOfStaffMemory.ChiefOfStaffMemory;
      const entries = yield* memory
        .history(memberId, { label: params.label, limit: params.limit })
        .pipe(Effect.mapError(memoryFailure));
      return { entries };
    }),
  ),
});
