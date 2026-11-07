import type { NewTaskWorkspaceMode } from "../../lib/newTaskWorkspaceMode";

export function resolveProjectThreadCreationBranch(input: {
  readonly workspaceMode: NewTaskWorkspaceMode;
  readonly selectedBranch: string | null;
  readonly currentCheckoutBranch: string | null;
}): string | null {
  if (input.selectedBranch !== null) {
    return input.selectedBranch;
  }
  return input.workspaceMode === "local" ? input.currentCheckoutBranch : null;
}
