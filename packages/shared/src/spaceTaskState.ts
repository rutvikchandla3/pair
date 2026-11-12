import type { MemberId, OrchestrationV2ThreadShell } from "@t3tools/contracts";

/** A space task's status, derived from its thread; never stored (docs/product/spaces.md). */
export type SpaceTaskState =
  | { readonly type: "not-started" }
  | { readonly type: "working" }
  | {
      readonly type: "needs";
      readonly memberId: MemberId | null;
      readonly reason: "answer" | "approval";
    }
  | { readonly type: "failed" }
  | { readonly type: "limited" }
  | { readonly type: "stopped" }
  | { readonly type: "in-review" }
  | { readonly type: "done" };

export type SpaceTaskStateInput = Pick<
  OrchestrationV2ThreadShell,
  | "latestRunId"
  | "status"
  | "pendingRuntimeRequest"
  | "lastErrorClass"
  | "limitRecovery"
  | "ownerId"
  | "linkedPullRequest"
  | "branchPullRequest"
  | "pullRequests"
  | "settledAt"
>;

const ANSWER_KINDS = new Set(["user_input", "mcp-elicitation"]);

/** The shell knows a pull request exists, not whether it merged: settling the task marks it Done. */
export function spaceTaskState(thread: SpaceTaskStateInput): SpaceTaskState {
  if (thread.latestRunId === null) return { type: "not-started" };
  const request = thread.pendingRuntimeRequest;
  if (request !== null && request.blocking !== false) {
    return {
      type: "needs",
      memberId: thread.ownerId ?? null,
      reason: ANSWER_KINDS.has(request.kind) ? "answer" : "approval",
    };
  }
  if (thread.limitRecovery?.runId === thread.latestRunId) return { type: "limited" };
  switch (thread.status) {
    case "idle":
    case "completed": {
      const hasPullRequest =
        (thread.linkedPullRequest ?? thread.branchPullRequest ?? null) !== null ||
        (thread.pullRequests?.length ?? 0) > 0;
      return hasPullRequest && thread.settledAt === null ? { type: "in-review" } : { type: "done" };
    }
    case "failed":
      return thread.lastErrorClass === "usage_limit" ? { type: "limited" } : { type: "failed" };
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return { type: "stopped" };
    default:
      return { type: "working" };
  }
}
