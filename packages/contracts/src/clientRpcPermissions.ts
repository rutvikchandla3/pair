import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput, GitRunStackedActionInput } from "./git.ts";
import {
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.providerAuthRemoveMethod]: AuthProvidersManageScope,
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  // Stopping a server signals its processes, as closing a terminal does.
  [WS_METHODS.previewStopLocalServer]: AuthTerminalOperateScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  // Restarts the server, as an update does.
  [WS_METHODS.serverReclaimDatabaseSpace]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  // A check boots a machine on the server's compute, as storage cleanup acts on its disk.
  [WS_METHODS.sandboxCheckDriver]: AuthSettingsWriteScope,
  // A build boots a machine and changes what every new cloud machine starts from.
  [WS_METHODS.teamImageSaveRecipe]: AuthSettingsWriteScope,
  [WS_METHODS.teamImageStartBuild]: AuthSettingsWriteScope,
  [WS_METHODS.teamImageCancelBuild]: AuthSettingsWriteScope,
  [WS_METHODS.teamImageActivateBuild]: AuthSettingsWriteScope,
  [WS_METHODS.teamImageDismissProposal]: AuthSettingsWriteScope,
  [WS_METHODS.teamImageSetSecret]: AuthSettingsWriteScope,
  [WS_METHODS.teamImageRemoveSecret]: AuthSettingsWriteScope,
  // @pair replies on this key in every space, so only admins replace or remove it.
  [WS_METHODS.teamClaudeKeySet]: AuthSettingsWriteScope,
  [WS_METHODS.teamClaudeKeyRemove]: AuthSettingsWriteScope,
  // A lease keeps a machine awake, so read-only sessions cannot hold one.
  [WS_METHODS.sandboxViewing]: AuthOrchestrationOperateScope,
  // The same stop `sandbox.sleep` and `sandbox.discard` send, by machine id.
  [WS_METHODS.sandboxStopById]: AuthOrchestrationOperateScope,
  // The desktop types and clicks on the machine, as a terminal does.
  [WS_METHODS.sandboxDesktop]: AuthTerminalOperateScope,
  // Starts a thread and a machine, as a cloud launch does.
  [WS_METHODS.sandboxFork]: AuthOrchestrationOperateScope,
  // Creates a worktree and a thread here.
  [WS_METHODS.threadMoveToLocal]: AuthOrchestrationOperateScope,
  // A move starts a thread on Pair Cloud through this server's link.
  [WS_METHODS.threadMoveToCloud]: AuthOrchestrationOperateScope,
  // Space writes dispatch orchestration commands; a task start runs a provider turn.
  [WS_METHODS.spacesMutate]: AuthOrchestrationOperateScope,
  [WS_METHODS.spacesPost]: AuthOrchestrationOperateScope,
  [WS_METHODS.spacesTask]: AuthOrchestrationOperateScope,
  [WS_METHODS.spacesAction]: AuthOrchestrationOperateScope,
  [WS_METHODS.spacesNotes]: AuthOrchestrationOperateScope,
  [WS_METHODS.spacesReply]: AuthOrchestrationOperateScope,
  // Done and Snooze change what the caller's Inbox shows, as a thread's snooze does.
  [WS_METHODS.inboxDismiss]: AuthOrchestrationOperateScope,
  [WS_METHODS.inboxSnooze]: AuthOrchestrationOperateScope,
  [WS_METHODS.inboxUnsnooze]: AuthOrchestrationOperateScope,
  [WS_METHODS.botsSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.botsCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.botsUpdate]: AuthOrchestrationOperateScope,
  [WS_METHODS.botsPause]: AuthOrchestrationOperateScope,
  [WS_METHODS.botsResume]: AuthOrchestrationOperateScope,
  [WS_METHODS.botsDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.botsMarkSeen]: AuthOrchestrationOperateScope,
  [WS_METHODS.botsCreateJob]: AuthOrchestrationOperateScope,
  [WS_METHODS.botsStopJob]: AuthOrchestrationOperateScope,
  [WS_METHODS.botsReopenJob]: AuthOrchestrationOperateScope,
  [WS_METHODS.botsArchiveJob]: AuthOrchestrationOperateScope,
  [WS_METHODS.botsAnswerAsk]: AuthOrchestrationOperateScope,
  [WS_METHODS.botsRememberAsk]: AuthOrchestrationOperateScope,
  [WS_METHODS.botsCorrectDecision]: AuthOrchestrationOperateScope,
  [WS_METHODS.botsHandBackSession]: AuthOrchestrationOperateScope,
  [WS_METHODS.botsUpdateNote]: AuthOrchestrationOperateScope,
  [WS_METHODS.botsDeleteNote]: AuthOrchestrationOperateScope,
  // Draining holds every member's new cloud turns, as an update restarts the server.
  [WS_METHODS.serverDrain]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverCancelDrain]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverCheckSecretSource]: AuthSettingsWriteScope,
  // Listing models spends the stored API key, so only those who can choose a model may.
  [WS_METHODS.serverListTextGeneratorModels]: AuthSettingsWriteScope,
  [WS_METHODS.serverRefreshProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesCreate]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesComment]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesSetState]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesReact]: AuthSourceControlWriteScope,
  // A tracker credential and a project's binding are settings, saved under the same grant.
  [WS_METHODS.issueTrackersConnect]: AuthSettingsWriteScope,
  [WS_METHODS.issueTrackersBindProject]: AuthSettingsWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsCreateFromThread]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlStar]: AuthSourceControlWriteScope,
  // Signing in replaces the server's GitHub credential, as saving a token in Settings does.
  [WS_METHODS.sourceControlSignInStart]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInWait]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInCancel]: AuthSettingsWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  // Starts an agent session on this environment that can read its logs and database.
  [WS_METHODS.serverPrepareTriage]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  // Force stop kills agent processes, as Stop on a terminal does.
  [ORCHESTRATION_V2_WS_METHODS.forceStopThread]: AuthOrchestrationOperateScope,
  // A guest link hands thread access to someone outside, like a pairing link.
  [WS_METHODS.guestShareCreate]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksLink]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksUnlink]: AuthAccessWriteScope,
  // A link lets every agent here reach the other environment: Settings' bar.
  [WS_METHODS.peerLinksAnswerRequest]: AuthAccessWriteScope,
  [WS_METHODS.teamInvite]: AuthAccessWriteScope,
  [WS_METHODS.teamSignInLink]: AuthAccessWriteScope,
  [WS_METHODS.teamUpdate]: AuthAccessWriteScope,
  [WS_METHODS.teamSetRole]: AuthAccessWriteScope,
  [WS_METHODS.teamRemove]: AuthAccessWriteScope,
  [WS_METHODS.teamRemovalPreview]: AuthAccessWriteScope,
  [WS_METHODS.pushRegister]: AuthOrchestrationReadScope,
  [WS_METHODS.pushUnregister]: AuthOrchestrationReadScope,
  // Ownership, not a scope, limits which accounts a member can change.
  [WS_METHODS.teamProviderAccountsMutate]: AuthOrchestrationOperateScope,
  [WS_METHODS.teamGitHubTokenSet]: AuthOrchestrationOperateScope,
  [WS_METHODS.teamGitHubTokenClear]: AuthOrchestrationOperateScope,
  // Branch off starts a thread and maybe a machine, as a cloud launch does.
  [WS_METHODS.threadBranchOff]: AuthOrchestrationOperateScope,
  // Update, Offer, Apply and the rest write to a thread's worktree and its record.
  [WS_METHODS.threadUpdate]: AuthOrchestrationOperateScope,
  [WS_METHODS.threadAbortUpdate]: AuthOrchestrationOperateScope,
  [WS_METHODS.threadUndoUpdate]: AuthOrchestrationOperateScope,
  [WS_METHODS.threadBringBack]: AuthOrchestrationOperateScope,
  [WS_METHODS.offerCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.offerWithdraw]: AuthOrchestrationOperateScope,
  [WS_METHODS.offerApply]: AuthOrchestrationOperateScope,
  [WS_METHODS.offerDecline]: AuthOrchestrationOperateScope,
  [WS_METHODS.threadRevertOffer]: AuthOrchestrationOperateScope,
  // Starts a machine on the caller's machine time.
  [WS_METHODS.threadMoveToOwnMachine]: AuthOrchestrationOperateScope,
  // Runs a model on the caller's provider account.
  [WS_METHODS.threadBranchOffSummary]: AuthOrchestrationOperateScope,
  [WS_METHODS.threadStartFromMain]: AuthOrchestrationOperateScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

// Reads only `type`, so guarding sandbox commands never decodes the whole command union.
const isSandboxCommandInput = (input: unknown) =>
  Predicate.hasProperty(input, "type") &&
  typeof input.type === "string" &&
  input.type.startsWith("sandbox.");

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);
const decodeStackedAction = Schema.decodeUnknownSync(GitRunStackedActionInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  // The server requires operate for every dispatch; this makes a sandbox command fail closed.
  if (method === ORCHESTRATION_V2_WS_METHODS.dispatchCommand && isSandboxCommandInput(input))
    return [AuthOrchestrationOperateScope];
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  if (method === WS_METHODS.gitRunStackedAction && input !== undefined) {
    const payload = decodeStackedAction(input);
    if (
      payload.threadId !== undefined &&
      (payload.action === "create_pr" || payload.action === "commit_push_pr")
    )
      return [AuthSourceControlWriteScope, AuthOrchestrationReadScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
