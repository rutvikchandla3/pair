import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS, type WsRpcGroup } from "./rpc.ts";

/** What one RPC input points at. A member's session may use it only with access (11 §4). */
export type RpcThreadTarget =
  | { readonly threadId: string }
  | { readonly sandboxId: string }
  | { readonly path: string };

type WsRpc = RpcGroup.Rpcs<typeof WsRpcGroup>;
type WsMethod = WsRpc["_tag"];
type WsPayload<M extends WsMethod> = Rpc.Payload<Rpc.ExtractTag<WsRpc, M>>;

const thread = (input: { readonly threadId: string }): ReadonlyArray<RpcThreadTarget> => [
  { threadId: input.threadId },
];
const cwd = (input: { readonly cwd: string }): ReadonlyArray<RpcThreadTarget> => [
  { path: input.cwd },
];
const paths = (...candidates: ReadonlyArray<string | null | undefined>) =>
  candidates.flatMap((path): ReadonlyArray<RpcThreadTarget> => (path ? [{ path }] : []));
/** The server resolves `relative` against `cwd`, so an absolute or `..` one can leave it. */
const within = (root: string, relative: string | undefined) =>
  relative === undefined ? [] : paths(relative.startsWith("/") ? relative : `${root}/${relative}`);

/**
 * What each method's input names. The middleware checks every target before the handler runs; a
 * method absent here and from `RPC_THREAD_TARGET_EXEMPT` names no thread, machine or path.
 */
export const RPC_THREAD_TARGETS: {
  readonly [M in WsMethod]?: (input: WsPayload<M>) => ReadonlyArray<RpcThreadTarget>;
} = {
  [WS_METHODS.guestShareCreate]: thread,
  [WS_METHODS.serverRefreshProviders]: (input) => paths(input.cwd),
  [WS_METHODS.peerLinksAnswerRequest]: thread,
  [WS_METHODS.threadMovePreview]: thread,
  [WS_METHODS.threadMoveToCloud]: thread,
  [WS_METHODS.sandboxViewing]: thread,
  [WS_METHODS.scheduledTasksUpsert]: (input) => [
    ...(input.threadId ? [{ threadId: input.threadId }] : []),
    ...paths(
      input.workspaceStrategy && "worktreePath" in input.workspaceStrategy
        ? input.workspaceStrategy.worktreePath
        : undefined,
    ),
  ],
  [WS_METHODS.secretsAnswerRequest]: thread,
  [WS_METHODS.sourceControlLookupRepository]: (input) => paths(input.cwd),
  [WS_METHODS.sourceControlCloneRepository]: (input) => paths(input.destinationPath),
  [WS_METHODS.sourceControlPublishRepository]: cwd,
  [WS_METHODS.projectCloneStart]: (input) => paths(input.destinationPath),
  [WS_METHODS.projectsListEntries]: (input) => [
    ...cwd(input),
    ...within(input.cwd, input.directoryPath),
  ],
  [WS_METHODS.projectsListIgnoredFiles]: cwd,
  [WS_METHODS.projectsReadFile]: (input) => [
    ...cwd(input),
    ...within(input.cwd, input.relativePath),
  ],
  [WS_METHODS.projectsSearchContents]: cwd,
  [WS_METHODS.projectsSearchEntries]: cwd,
  [WS_METHODS.projectsWriteFile]: (input) => [
    ...cwd(input),
    ...within(input.cwd, input.relativePath),
  ],
  [WS_METHODS.projectsMutate]: (input) =>
    paths("workspaceRoot" in input ? input.workspaceRoot : undefined),
  [WS_METHODS.projectsCreateFromThread]: thread,
  [WS_METHODS.shellOpenInEditor]: cwd,
  [WS_METHODS.filesystemBrowse]: (input) => paths(input.partialPath, input.cwd),
  [WS_METHODS.filesystemGetMetadata]: (input) => paths(...input.paths),
  [WS_METHODS.agentSessionsImport]: (input) => paths(input.expectedWorkspaceRoot),
  [WS_METHODS.assetsCreateUrl]: ({ resource }) => {
    switch (resource._tag) {
      case "workspace-file":
      case "media-file":
        return [{ threadId: resource.threadId }, ...paths(resource.path)];
      case "tool-output-image":
        return [{ threadId: resource.threadId }];
      case "draft-workspace-file":
        return [...cwd(resource), ...within(resource.cwd, resource.path)];
      case "project-favicon":
      case "github-media":
        return cwd(resource);
      // An attachment id is unguessable, and a member learns one only from a thread they can read.
      case "attachment":
      case "native-app-icon":
        return [];
    }
  },
  [WS_METHODS.assetsPersistChatAttachments]: thread,
  [WS_METHODS.mcpAppsCallTool]: thread,
  [WS_METHODS.mcpAppsToolInfo]: thread,
  [WS_METHODS.mcpAppsReadResource]: thread,
  [WS_METHODS.mcpAppsUpdateModelContext]: (input) => [
    { threadId: input.threadId },
    { threadId: input.conversationThreadId },
  ],
  [WS_METHODS.providerUploadFeedback]: thread,
  [WS_METHODS.subscribeVcsStatus]: cwd,
  [WS_METHODS.subscribeWorktreeSetup]: thread,
  [WS_METHODS.worktreeSetupCancel]: thread,
  [WS_METHODS.vcsPull]: cwd,
  [WS_METHODS.vcsRefreshStatus]: cwd,
  [WS_METHODS.vcsListRefs]: cwd,
  [WS_METHODS.vcsCreateWorktree]: (input) => paths(input.cwd, input.path),
  [WS_METHODS.vcsRemoveWorktree]: (input) => paths(input.cwd, input.path),
  [WS_METHODS.vcsCreateRef]: cwd,
  [WS_METHODS.vcsSwitchRef]: cwd,
  [WS_METHODS.vcsInit]: cwd,
  [WS_METHODS.gitRunStackedAction]: (input) => [
    ...cwd(input),
    ...(input.threadId ? [{ threadId: input.threadId }] : []),
  ],
  [WS_METHODS.gitResolvePullRequest]: cwd,
  [WS_METHODS.gitPreparePullRequestThread]: (input) => [
    ...cwd(input),
    ...(input.threadId ? [{ threadId: input.threadId }] : []),
  ],
  [WS_METHODS.reviewGetBranchCommits]: cwd,
  [WS_METHODS.reviewGetDiffPreview]: cwd,
  [WS_METHODS.reviewGetDiffFileContents]: cwd,
  [WS_METHODS.terminalOpen]: (input) => [
    { threadId: input.threadId },
    ...paths(input.cwd, input.worktreePath),
  ],
  [WS_METHODS.terminalAttach]: (input) => [
    { threadId: input.threadId },
    ...paths(input.cwd, input.worktreePath),
  ],
  [WS_METHODS.terminalObserve]: thread,
  [WS_METHODS.terminalWrite]: thread,
  [WS_METHODS.terminalResize]: thread,
  [WS_METHODS.terminalClear]: thread,
  [WS_METHODS.terminalClose]: thread,
  [WS_METHODS.previewOpen]: thread,
  [WS_METHODS.previewResize]: thread,
  [WS_METHODS.previewAdjust]: thread,
  [WS_METHODS.previewClose]: thread,
  [WS_METHODS.previewList]: thread,
  [WS_METHODS.previewReportStatus]: thread,
  [WS_METHODS.deviceOpen]: thread,
  [WS_METHODS.deviceClose]: thread,
  [ORCHESTRATION_V2_WS_METHODS.getWorkflowScript]: (input) => [
    { threadId: input.threadId },
    ...paths(input.scriptPath),
  ],
  [ORCHESTRATION_V2_WS_METHODS.getNativeChildWork]: thread,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: thread,
  [ORCHESTRATION_V2_WS_METHODS.forceStopThread]: thread,
  [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: thread,
  [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: thread,
  [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: thread,
  [ORCHESTRATION_V2_WS_METHODS.searchThread]: thread,
  [ORCHESTRATION_V2_WS_METHODS.searchThreadStream]: thread,
  [ORCHESTRATION_V2_WS_METHODS.getThreadFamily]: thread,
  [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: thread,
  [ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds]: (input) => paths(input.worktreePath),
  [ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput]: thread,
  // A new thread's id names nothing yet; only a reused one must be the member's to open.
  [ORCHESTRATION_V2_WS_METHODS.launchThread]: (input) => [
    ...(input.reuseExistingThread === true && input.threadId ? [{ threadId: input.threadId }] : []),
    ...paths(
      "worktreePath" in input.workspaceStrategy ? input.workspaceStrategy.worktreePath : undefined,
    ),
  ],
};

/** The targets of one decoded payload, or undefined when the method names none. */
export const rpcThreadTargets = (
  method: string,
  payload: unknown,
): ReadonlyArray<RpcThreadTarget> | undefined => {
  const targets = RPC_THREAD_TARGETS[method as WsMethod] as
    | ((input: unknown) => ReadonlyArray<RpcThreadTarget>)
    | undefined;
  return targets?.(payload);
};

/** Methods whose input has a target-like field the table does not check, and why. */
export const RPC_THREAD_TARGET_EXEMPT: { readonly [M in WsMethod]?: string } = {
  [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]:
    "ThreadMessageIntake.assertCommandAccess checks each command kind's threads and paths.",
  [ORCHESTRATION_V2_WS_METHODS.subscribeThread]:
    "A refused or revoked subscription must look like a missing thread's (11 §4), not fail: the handler asserts access and ends it with ThreadAccessRevoked.",
  [ORCHESTRATION_V2_WS_METHODS.getThreadTitles]:
    "A batch: the handler drops the titles the viewer cannot open, so one hidden id does not fail the rest.",
  [ORCHESTRATION_V2_WS_METHODS.getOlderSettledThreads]:
    "`before` is a page cursor, not a target; the page's SQL keeps only threads the viewer can open.",
  [WS_METHODS.presenceReport]:
    "Reports the caller's own view; who may see it is presence's filter (6.4).",
  [WS_METHODS.serverReportClientActivity]:
    "A lease only schedules background refreshes for the caller and returns nothing.",
  [WS_METHODS.threadMoveToLocal]:
    "`source` is a thread on the linked cloud environment, which checks the link's member.",
  [WS_METHODS.pullRequestsThreadComments]: "`threadId` is a review thread on the code host.",
  [WS_METHODS.pullRequestsReplyToThread]: "`threadId` is a review thread on the code host.",
  [WS_METHODS.pullRequestsSetThreadResolution]: "`threadId` is a review thread on the code host.",
  [WS_METHODS.pullRequestsDiffFileContents]:
    "Paths are inside a pull request, read from the code host.",
  [WS_METHODS.pullRequestsSetFilesViewed]:
    "Paths are inside a pull request, marked on the code host.",
  [WS_METHODS.pullRequestsSubmitReview]: "Paths are inside a pull request, sent to the code host.",
};
