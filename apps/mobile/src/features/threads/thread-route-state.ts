import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export type NewTaskDraftRouteParams = {
  readonly requestId?: string;
  readonly environmentId?: string | string[];
  readonly projectId?: string | string[];
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  /** "cloud": a new machine from `branch`, as "New thread on branch" offers for a cloud thread. */
  readonly workspace?: "cloud";
  readonly title?: string | string[];
  readonly cloning?: string | string[];
  readonly draftId?: string | string[];
  readonly incomingShareId?: string | string[];
};

export function isDraftThreadRoute(
  route:
    | {
        readonly name: string;
        readonly params?: object;
      }
    | undefined,
) {
  return (
    route?.name === "Thread" && Boolean((route.params as { draft?: unknown } | undefined)?.draft)
  );
}

export function submittedThreadParams(environmentId: string, threadId: string) {
  return { draft: undefined, environmentId, threadId };
}

export function draftRouteIdentity(draft: NewTaskDraftRouteParams): string {
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  return JSON.stringify([
    draft.requestId,
    first(draft.draftId),
    first(draft.environmentId),
    first(draft.projectId),
    draft.branch ?? null,
    draft.worktreePath ?? null,
    draft.workspace ?? null,
    first(draft.incomingShareId),
  ]);
}

/**
 * "New thread on branch": a local draft on the thread's checkout, or for a cloud thread a cloud
 * draft from its branch, since its worktree path is inside its machine.
 */
export function newThreadOnBranchDraft(
  thread: Pick<
    EnvironmentThreadShell,
    "environmentId" | "projectId" | "branch" | "worktreePath"
  > & {
    readonly source: Pick<EnvironmentThreadShell["source"], "sandboxId">;
  },
  requestId: string,
): NewTaskDraftRouteParams {
  const base = {
    requestId,
    environmentId: String(thread.environmentId),
    projectId: String(thread.projectId),
    branch: thread.branch,
  };
  return thread.source.sandboxId === undefined
    ? { ...base, worktreePath: thread.worktreePath }
    : { ...base, worktreePath: null, workspace: "cloud" };
}
