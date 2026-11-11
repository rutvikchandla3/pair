import { useAtomMount } from "@effect/atom-react";

import { EnvironmentProject, EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  createVcsStatusRevalidationAtomFamily,
  type GitActionRequestInput,
  type VcsActionOperation,
  type VcsRef,
  vcsActionErrorMessage,
} from "@t3tools/client-runtime/state/vcs";
import {
  describeWorkspaceGitActionOutcome,
  runWorkspaceGitActions,
  type ThreadRepository,
  type WorkspaceGitActionPlan,
} from "@t3tools/client-runtime/state/workspaces";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentAuthorizationError,
  type GitRunStackedActionResult,
} from "@t3tools/contracts";
import {
  dedupeRemoteBranchesWithLocalMatches,
  sanitizeFeatureBranchName,
} from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { useBranches } from "../state/queries";
import { threadEnvironment } from "../state/threads";
import { vcsActionManager, vcsEnvironment } from "../state/vcs";
import { uuidv4 } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { readEnvironmentScope, useEnvironmentScope } from "./session";
import {
  environmentConnectedAtom,
  setPendingConnectionError,
} from "./use-remote-environment-registry";
import { useAtomCommand } from "./use-atom-command";
import { showGitActionResult } from "./use-vcs-action-state";
import { useThreadSelection } from "./use-thread-selection";
import { useSelectedThreadWorktree } from "./use-selected-thread-worktree";
import { useSelectedThreadGitTarget } from "./use-selected-thread-git-target";
import { setWorkspaceRun } from "./use-selected-thread-workspace";

function refreshFailureMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : "Failed to refresh git status.";
}

// Selecting a thread or reconnecting its environment refreshes the checkout's
// status once, shared by every sheet that shows it.
const selectedThreadStatusRevalidation = createVcsStatusRevalidationAtomFamily({
  refreshStatus: vcsEnvironment.refreshStatus,
  connected: environmentConnectedAtom,
  onRefreshed: (result) =>
    setPendingConnectionError(
      AsyncResult.isFailure(result) ? refreshFailureMessage(result.cause) : null,
    ),
});

export function useSelectedThreadGitActions() {
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const readRefs = useAtomCommand(vcsEnvironment.readRefs, { reportFailure: false });
  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const switchRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });
  const createRef = useAtomCommand(vcsEnvironment.createRef, { reportFailure: false });
  const createWorktree = useAtomCommand(vcsEnvironment.createWorktree, { reportFailure: false });
  const pull = useAtomCommand(vcsEnvironment.pull, { reportFailure: false });
  const { selectedThread } = useThreadSelection();
  const canWriteSourceControl = useEnvironmentScope(
    selectedThread?.environmentId ?? null,
    AuthSourceControlWriteScope,
  );
  const canOperateThread = useEnvironmentScope(
    selectedThread?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const { selectedThreadWorktreePath } = useSelectedThreadWorktree();
  // A workspace thread's git runs in its selected repository, never in its folder of repositories.
  const target = useSelectedThreadGitTarget();
  const workspace = target.workspace;
  const selectedThreadCwd = target.cwd;
  const selectedThreadProject = target.project;
  // A workspace thread's repositories share one branch name, so nothing here renames the thread's.
  const canChangeThreadBranch = workspace === null && canWriteSourceControl && canOperateThread;
  // A workspace repository's branch is its folder's, not thread metadata.
  const canSwitchBranch = workspace === null ? canChangeThreadBranch : canWriteSourceControl;
  const runStackedAction = useAtomCommand(
    vcsActionManager.runStackedAction({
      environmentId: selectedThread?.environmentId ?? null,
      cwd: selectedThreadCwd,
    }),
    { reportFailure: false },
  );

  const branchTarget = {
    environmentId: selectedThread?.environmentId ?? null,
    cwd: target.rootCwd,
    query: null,
  };
  const branchState = useBranches(branchTarget);
  const updateThreadGitContext = async (
    thread: NonNullable<typeof selectedThread>,
    nextState: {
      readonly branch?: string | null;
      readonly worktreePath?: string | null;
    },
  ) => {
    if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) {
      return AsyncResult.failure<never, EnvironmentAuthorizationError>(
        Cause.fail(
          new EnvironmentAuthorizationError({
            requiredScope: AuthOrchestrationOperateScope,
            message: "This connection cannot update the thread's branch.",
          }),
        ),
      );
    }
    return updateThreadMetadata({
      environmentId: thread.environmentId,
      input: {
        threadId: thread.id,
        ...(nextState.branch !== undefined ? { branch: nextState.branch } : {}),
        ...(nextState.worktreePath !== undefined ? { worktreePath: nextState.worktreePath } : {}),
      },
    });
  };

  const refreshSelectedThreadGitStatus = async (options?: {
    readonly quiet?: boolean;
    readonly cwd?: string | null;
  }) => {
    if (!selectedThread || !selectedThreadProject) {
      return null;
    }

    const cwd = options?.cwd ?? selectedThreadCwd;
    if (!cwd) {
      return null;
    }

    const target = { environmentId: selectedThread.environmentId, cwd };
    const execute = () =>
      refreshStatus({
        environmentId: selectedThread.environmentId,
        input: { cwd },
      });
    const result = options?.quiet
      ? await execute()
      : await vcsActionManager.track(
          appAtomRegistry,
          target,
          {
            operation: "refresh_status",
            label: "Refreshing source control status",
          },
          execute,
        );
    if (AsyncResult.isFailure(result)) {
      setPendingConnectionError(refreshFailureMessage(result.cause));
      return null;
    }
    setPendingConnectionError(null);
    return result.value;
  };

  useAtomMount(
    selectedThreadStatusRevalidation(
      selectedThread && selectedThreadProject && selectedThreadCwd
        ? { environmentId: selectedThread.environmentId, cwd: selectedThreadCwd }
        : null,
    ),
  );

  const runSelectedThreadGitMutation = async <T, E>(
    operation: VcsActionOperation,
    label: string,
    execute: (input: {
      readonly thread: EnvironmentThreadShell;
      readonly project: EnvironmentProject;
      readonly cwd: string;
    }) => Promise<AtomCommandResult<T, E>>,
    options?: { readonly managedExternally?: boolean; readonly changesThreadBranch?: boolean },
  ): Promise<T | null> => {
    if (
      !selectedThread ||
      !selectedThreadProject ||
      !selectedThreadCwd ||
      !readEnvironmentScope(selectedThread.environmentId, AuthSourceControlWriteScope) ||
      (options?.changesThreadBranch === true &&
        !readEnvironmentScope(selectedThread.environmentId, AuthOrchestrationOperateScope))
    ) {
      return null;
    }

    const target = {
      environmentId: selectedThread.environmentId,
      cwd: selectedThreadCwd,
    };
    setPendingConnectionError(null);
    const run = () =>
      execute({
        thread: selectedThread,
        project: selectedThreadProject,
        cwd: selectedThreadCwd,
      });
    const result =
      options?.managedExternally === true
        ? await run()
        : await vcsActionManager.track(appAtomRegistry, target, { operation, label }, run);
    if (AsyncResult.isFailure(result)) {
      const error = Cause.squash(result.cause);
      const message = error instanceof Error ? error.message : "Git action failed.";
      setPendingConnectionError(message);
      showGitActionResult({ type: "error", title: "Git action failed", description: message });
      return null;
    }
    return result.value;
  };

  const refreshSelectedThreadBranches = async (): Promise<ReadonlyArray<VcsRef> | null> => {
    if (branchTarget.environmentId === null || branchTarget.cwd === null) return null;
    const result = await readRefs({
      environmentId: branchTarget.environmentId,
      input: { cwd: branchTarget.cwd, limit: 100, refresh: true },
    });
    if (AsyncResult.isFailure(result)) {
      const error = Cause.squash(result.cause);
      const message = error instanceof Error ? error.message : "Failed to refresh branches.";
      setPendingConnectionError(message);
      showGitActionResult({ type: "error", title: "Git action failed", description: message });
      return null;
    }
    setPendingConnectionError(null);
    return dedupeRemoteBranchesWithLocalMatches(result.value.refs).filter(
      (branch) => !branch.isRemote,
    );
  };

  const syncSelectedThreadBranchState = async (input: {
    readonly thread: EnvironmentThreadShell;
    readonly cwd: string;
    readonly nextThreadState?: {
      readonly branch?: string | null;
      readonly worktreePath?: string | null;
    };
  }): Promise<AtomCommandResult<void, unknown>> => {
    // Git already changed; refresh even if metadata updates fail so the sheet shows the current branch.
    const updateResult = input.nextThreadState
      ? await updateThreadGitContext(input.thread, input.nextThreadState)
      : AsyncResult.success(undefined);
    branchState.refresh();
    await refreshSelectedThreadGitStatus({ quiet: true, cwd: input.cwd });
    return AsyncResult.isFailure(updateResult)
      ? AsyncResult.failure(updateResult.cause)
      : AsyncResult.success(undefined);
  };

  const onCheckoutSelectedThreadBranch = async (branch: string) => {
    return runSelectedThreadGitMutation(
      "switch_ref",
      "Switching branch",
      async ({ thread, cwd }) => {
        const result = await switchRef({
          environmentId: thread.environmentId,
          input: { cwd, refName: branch },
        });
        if (AsyncResult.isFailure(result)) {
          return result;
        }
        const syncResult = await syncSelectedThreadBranchState({
          thread,
          cwd,
          ...(workspace === null
            ? {
                nextThreadState: {
                  branch: result.value.refName ?? thread.branch,
                  worktreePath: selectedThreadWorktreePath,
                },
              }
            : {}),
        });
        return AsyncResult.isFailure(syncResult) ? AsyncResult.failure(syncResult.cause) : result;
      },
      { changesThreadBranch: workspace === null },
    );
  };

  const onCreateSelectedThreadBranch = async (branch: string) => {
    return runSelectedThreadGitMutation(
      "create_ref",
      "Creating branch",
      async ({ thread, cwd }) => {
        const result = await createRef({
          environmentId: thread.environmentId,
          input: { cwd, refName: branch, switchRef: true },
        });
        if (AsyncResult.isFailure(result)) {
          return result;
        }
        const syncResult = await syncSelectedThreadBranchState({
          thread,
          cwd,
          ...(workspace === null
            ? {
                nextThreadState: {
                  branch: result.value.refName ?? thread.branch,
                  worktreePath: selectedThreadWorktreePath,
                },
              }
            : {}),
        });
        return AsyncResult.isFailure(syncResult) ? AsyncResult.failure(syncResult.cause) : result;
      },
      { changesThreadBranch: workspace === null },
    );
  };

  const onCreateSelectedThreadWorktree = async (nextWorktree: {
    readonly baseBranch: string;
    readonly newBranch: string;
  }) => {
    // A workspace thread already has one worktree per repository; it never moves to another.
    if (workspace !== null) return null;
    return runSelectedThreadGitMutation(
      "create_worktree",
      "Creating worktree",
      async ({ thread, project }) => {
        const result = await createWorktree({
          environmentId: thread.environmentId,
          input: {
            cwd: project.workspaceRoot,
            refName: nextWorktree.baseBranch,
            newRefName: sanitizeFeatureBranchName(nextWorktree.newBranch),
            path: null,
          },
        });
        if (AsyncResult.isFailure(result)) {
          return result;
        }
        const syncResult = await syncSelectedThreadBranchState({
          thread,
          cwd: result.value.worktree.path,
          nextThreadState: {
            branch: result.value.worktree.refName,
            worktreePath: result.value.worktree.path,
          },
        });
        return AsyncResult.isFailure(syncResult) ? AsyncResult.failure(syncResult.cause) : result;
      },
      { changesThreadBranch: true },
    );
  };

  const onPullSelectedThreadBranch = async () => {
    await runSelectedThreadGitMutation(
      "pull",
      "Pulling latest changes",
      async ({ thread, cwd }) => {
        const result = await pull({
          environmentId: thread.environmentId,
          input: { cwd },
        });
        if (AsyncResult.isFailure(result)) {
          return result;
        }
        await refreshSelectedThreadGitStatus({ quiet: true, cwd });
        showGitActionResult({
          type: "success",
          title:
            result.value.status === "skipped_up_to_date"
              ? "Already up to date"
              : `Pulled latest on ${result.value.refName}`,
        });
        return result;
      },
    );
  };

  const onRunSelectedThreadGitAction = async (
    input: GitActionRequestInput,
  ): Promise<GitRunStackedActionResult | null> => {
    if (workspace !== null && input.featureBranch === true) return null;
    const actionId = uuidv4();
    return await runSelectedThreadGitMutation(
      "run_change_request",
      "Running source control action",
      async ({ thread, cwd }) => {
        const result = await runStackedAction({
          actionId,
          action: input.action,
          ...(input.commitMessage ? { commitMessage: input.commitMessage } : {}),
          ...(input.featureBranch ? { featureBranch: input.featureBranch } : {}),
          ...(input.filePaths?.length ? { filePaths: [...input.filePaths] } : {}),
          threadId: thread.id,
        });
        if (AsyncResult.isFailure(result)) {
          return result;
        }

        if (
          workspace === null &&
          result.value.branch.status === "created" &&
          result.value.branch.name
        ) {
          const syncResult = await syncSelectedThreadBranchState({
            thread,
            cwd,
            nextThreadState: {
              branch: result.value.branch.name,
              worktreePath: selectedThreadWorktreePath,
            },
          });
          if (AsyncResult.isFailure(syncResult)) {
            return AsyncResult.failure(syncResult.cause);
          }
        } else {
          await refreshSelectedThreadGitStatus({ quiet: true, cwd });
        }
        showGitActionResult({
          type: "success",
          title: result.value.toast.title,
          description: result.value.toast.description,
          prUrl: result.value.toast.cta.kind === "open_pr" ? result.value.toast.cta.url : undefined,
        });
        return result;
      },
      { managedExternally: true, changesThreadBranch: input.featureBranch === true },
    );
  };

  /** Runs a plan over a workspace thread's repositories, one at a time, and reports the outcome. */
  const onRunWorkspaceGitActions = async (input: {
    readonly plan: WorkspaceGitActionPlan<ThreadRepository>;
    readonly commitMessage: string;
  }) => {
    if (
      !selectedThread ||
      workspace === null ||
      workspace.run !== null ||
      !readEnvironmentScope(selectedThread.environmentId, AuthSourceControlWriteScope)
    ) {
      return null;
    }
    const { environmentId, id: threadId } = selectedThread;
    const { threadKey } = workspace;
    setPendingConnectionError(null);
    const outcome = await runWorkspaceGitActions({
      plan: input.plan,
      onStart: (step, index, total) =>
        setWorkspaceRun(threadKey, {
          name: step.repository.name,
          cwd: step.repository.cwd,
          index,
          total,
        }),
      run: async (step) => {
        const includesCommit =
          step.action === "commit" ||
          step.action === "commit_push" ||
          step.action === "commit_push_pr";
        const result = await runAtomCommand(
          appAtomRegistry,
          vcsActionManager.runStackedAction({ environmentId, cwd: step.repository.cwd }),
          {
            actionId: uuidv4(),
            action: step.action,
            ...(includesCommit && input.commitMessage
              ? { commitMessage: input.commitMessage }
              : {}),
            threadId,
          },
          { reportFailure: false },
        );
        if (result._tag === "Success") return { ok: true } as const;
        return {
          ok: false,
          error: isAtomCommandInterrupted(result)
            ? "Cancelled."
            : vcsActionErrorMessage(squashAtomCommandFailure(result)),
        } as const;
      },
    });
    setWorkspaceRun(threadKey, null);
    const report = describeWorkspaceGitActionOutcome(outcome);
    showGitActionResult({
      type: report.failed ? "error" : "success",
      title: report.title,
      description: report.description,
    });
    return outcome;
  };

  return {
    /** Where these controls run git; null for a workspace thread before its folder exists. */
    gitCwd: selectedThreadCwd,
    /** The project these controls act for: a workspace thread's selected repository's. */
    gitProject: selectedThreadProject,
    workspace,
    canWriteSourceControl,
    canChangeThreadBranch,
    canSwitchBranch,
    refreshSelectedThreadGitStatus,
    refreshSelectedThreadBranches,
    onCheckoutSelectedThreadBranch,
    onCreateSelectedThreadBranch,
    onCreateSelectedThreadWorktree,
    onPullSelectedThreadBranch,
    onRunSelectedThreadGitAction,
    onRunWorkspaceGitActions,
  };
}
