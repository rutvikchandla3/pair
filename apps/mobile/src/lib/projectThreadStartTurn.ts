import {
  CommandId,
  MessageId,
  ThreadId,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationMessageContext,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import {
  deriveThreadTitleSeed,
  threadTitleTextFromPrompt,
} from "@t3tools/client-runtime/operations";
import { routedCloudLaunch } from "@t3tools/client-runtime/state/cloud-target";
import { WORKSPACE_WORKTREE_BASE_REF } from "@t3tools/client-runtime/state/workspaces";
import { msg } from "gt-react-native";

import { m } from "../i18n/messages";
import type { UploadedMobileAttachment } from "./attachmentUpload";
import type { NewTaskWorkspaceMode } from "./newTaskWorkspaceMode";

export interface ProjectThreadStartTurnSpec {
  readonly projectId: ProjectId;
  readonly projectCwd: string;
  readonly threadId: string;
  readonly commandId: string;
  readonly messageId: string;
  readonly createdAt: string;
  readonly text: string;
  readonly titleText?: string;
  readonly context?: OrchestrationMessageContext;
  readonly uploadedAttachments: ReadonlyArray<UploadedMobileAttachment | ChatAttachment>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspaceMode: NewTaskWorkspaceMode;
  /** A workspace project: the server names one branch for every repository. */
  readonly workspace?: boolean;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly startFromOrigin: boolean;
  /** Tracked repositories a new worktree takes, by path; absent leaves the choice to the server. */
  readonly worktreeRepositories?: ReadonlyArray<string>;
  readonly worktreeBranchName: string;
  /** Set on a Cloud launch routed from a local project: continue `branch` on Pair Cloud. */
  readonly routedFromDefaultBranch?: string;
}

export function buildProjectThreadStartTurnInput(spec: ProjectThreadStartTurnSpec) {
  const title = deriveThreadTitleSeed(
    { text: spec.titleText ?? spec.text, attachments: spec.uploadedAttachments },
    m,
  );
  const isWorktree = spec.workspaceMode === "worktree";
  const isLocal = spec.workspaceMode === "local";
  return {
    commandId: CommandId.make(spec.commandId),
    creationSource: "mobile" as const,
    threadId: ThreadId.make(spec.threadId),
    message: {
      messageId: MessageId.make(spec.messageId),
      role: "user" as const,
      text: spec.text,
      ...(spec.context ? { context: spec.context } : {}),
      attachments: spec.uploadedAttachments,
    },
    modelSelection: spec.modelSelection,
    titleSeed: title,
    runtimeMode: spec.runtimeMode,
    interactionMode: spec.interactionMode,
    bootstrap: {
      createThread: {
        projectId: spec.projectId,
        title,
        modelSelection: spec.modelSelection,
        runtimeMode: spec.runtimeMode,
        interactionMode: spec.interactionMode,
        branch: spec.workspace ? null : spec.branch,
        worktreePath: isLocal ? spec.worktreePath : null,
        createdAt: spec.createdAt,
      },
      ...(isWorktree
        ? {
            prepareWorktree: {
              projectCwd: spec.projectCwd,
              // The launch needs a base ref; the server ignores it for a plain project folder.
              baseBranch: spec.branch ?? "HEAD",
              branch: spec.worktreeBranchName,
              ...(spec.startFromOrigin ? { startFromOrigin: true } : {}),
              ...(spec.worktreeRepositories === undefined
                ? {}
                : { repositories: spec.worktreeRepositories.map((path) => ({ path })) }),
            },
            runSetupScript: true,
          }
        : {}),
      // The server clones and sets up the workspace in the machine.
      ...(spec.workspaceMode === "cloud"
        ? {
            prepareCloud: spec.workspace
              ? { baseRef: WORKSPACE_WORKTREE_BASE_REF }
              : spec.routedFromDefaultBranch === undefined
                ? { baseRef: spec.branch!, branch: spec.worktreeBranchName }
                : routedCloudLaunch({
                    selectedBranch: spec.branch!,
                    defaultBranch: spec.routedFromDefaultBranch,
                  }),
          }
        : {}),
    },
    createdAt: spec.createdAt,
  };
}

export function deriveThreadTitleFromPrompt(value: string): string {
  const title = threadTitleTextFromPrompt(value, m) || m(msg("New thread"));
  return title.length <= 72 ? title : `${title.slice(0, 69).trimEnd()}...`;
}
