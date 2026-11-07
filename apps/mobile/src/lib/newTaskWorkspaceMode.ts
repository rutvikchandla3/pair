import * as Schema from "effect/Schema";

/** Where a new task runs. Drafts and the outbox persist it; "cloud" needs a sandbox driver. */
export const NewTaskWorkspaceMode = Schema.Literals(["local", "worktree", "cloud"]);
export type NewTaskWorkspaceMode = typeof NewTaskWorkspaceMode.Type;
