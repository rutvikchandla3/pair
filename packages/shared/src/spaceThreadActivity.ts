import type { MemberId, OrchestrationV2ThreadShell } from "@t3tools/contracts";

/** What a thread on a space task is doing now. Never a task status: people set that. */
export type SpaceThreadActivity =
  | { readonly type: "working" }
  | {
      readonly type: "needs";
      readonly memberId: MemberId | null;
      readonly reason: "answer" | "approval";
    }
  | { readonly type: "failed"; readonly summary: string | null }
  | { readonly type: "limited" }
  | { readonly type: "stopped" }
  | { readonly type: "idle" };

export type SpaceThreadActivityInput = Pick<
  OrchestrationV2ThreadShell,
  | "latestRunId"
  | "status"
  | "pendingRuntimeRequest"
  | "lastError"
  | "lastErrorClass"
  | "limitRecovery"
  | "ownerId"
>;

const ANSWER_KINDS = new Set(["user_input", "mcp-elicitation"]);

/** A turn ending is `idle`, whatever its pull requests. */
export function spaceThreadActivity(thread: SpaceThreadActivityInput): SpaceThreadActivity {
  const request = thread.pendingRuntimeRequest;
  if (request !== null && request.blocking !== false) {
    return {
      type: "needs",
      memberId: thread.ownerId ?? null,
      reason: ANSWER_KINDS.has(request.kind) ? "answer" : "approval",
    };
  }
  if (thread.latestRunId !== null && thread.limitRecovery?.runId === thread.latestRunId) {
    return { type: "limited" };
  }
  switch (thread.status) {
    case "idle":
    case "completed":
      return { type: "idle" };
    case "failed":
      return thread.lastErrorClass === "usage_limit"
        ? { type: "limited" }
        : { type: "failed", summary: thread.lastError ?? null };
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return { type: "stopped" };
    default:
      return { type: "working" };
  }
}
