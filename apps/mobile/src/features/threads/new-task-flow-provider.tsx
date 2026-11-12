import { ActiveNewTaskContext } from "../../state/active-new-task";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import { resolveTeamNewThreadModelSelection } from "@t3tools/client-runtime/state/provider-instance-entries";
import { useNowMinuteMs } from "../../lib/clock";
import * as Dialog from "../../components/ui/Dialog";
import React, { useEffect, useRef, useState } from "react";

import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ServerConfig,
  ProviderInteractionMode,
  ProviderOptionSelection,
  RuntimeMode,
  ServerProvider,
} from "@t3tools/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  repositoryGroupingKeyOf,
  ThreadId,
} from "@t3tools/contracts";
import { threadContextsOutsideEnvironment } from "@t3tools/shared/composerContextReferences";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";

import {
  useEnvironmentServerConfig,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../../state/entities";
import type { TurnCommandMetadata } from "../../lib/commandMetadata";
import type { NewTaskWorkspaceMode } from "../../lib/newTaskWorkspaceMode";
import type { DraftComposerAttachment } from "../../lib/composerImages";
import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import {
  buildModelOptions,
  filterModelOptionsForViewer,
  groupByProvider,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
  resolveSelectableModelSelection,
  withCloudModelReasons,
} from "../../lib/modelOptions";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { useAtomValue } from "@effect/atom-react";
import { useTeamViewer } from "../../state/team";
import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironment } from "../../state/projects";
import { useLinkedEnvironments } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  appendComposerDraftAttachments,
  type ComposerDraftInsertion,
  type ComposerDraftWorkspaceSelection,
  composerDraftsLoadedAtom,
  createNewTaskDraft,
  getComposerDraftSnapshot,
  isNewTaskDraftKey,
  removeComposerDraftAttachment,
  replaceComposerDraftAttachments,
  retargetNewTaskDraft,
  setComposerDraftText,
  setStickyComposerModelSelection,
  updateComposerDraftSettings,
  useComposerDraft,
  useStickyComposerModelSelection,
} from "../../state/use-composer-drafts";
import {
  rememberModelOptions,
  withRememberedModelOptions,
} from "../../state/use-model-option-memory";
import { useBranches, usePaginatedBranches } from "../../state/queries";
import { vcsEnvironment } from "../../state/vcs";
import { type QueuedThreadMessage } from "../../state/thread-outbox";
import {
  setPendingConnectionError,
  useRemoteConnectionStatus,
  useSavedRemoteConnections,
} from "../../state/use-remote-environment-registry";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import {
  type CloudBranchCheck,
  cloudBranchCheck,
  isCloudLaunchEnvironment,
} from "@t3tools/client-runtime/state/cloud-target";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { type VcsRef } from "@t3tools/client-runtime/state/vcs";
import {
  buildHomeProjectScopes,
  sortHomeProjectScopes,
  type HomeProjectScope,
} from "../home/homeThreadList";
import { useMobileProjectGroupingSettings } from "../../state/project-grouping";
import {
  resolvePendingTaskInteractionMode,
  resolveProviderInteractionMode,
} from "../../state/legacy-plan-mode";
import { useLegacyPlanModeState } from "./use-legacy-plan-mode-enabled";
import {
  resolveNewTaskBaseBranchName,
  resolveNewTaskDraftWorkspace,
  resolveNewTaskBranchWorktreePath,
  resolveNewTaskLocalWorkspaceSelection,
} from "./new-task-context-presentation";
import { resolveEnvironmentProjectMatch } from "./new-task-project-selection";
import type { NewTaskCloud } from "./new-task-cloud";
import { useNewTaskProjectDefaults } from "./use-new-task-project-defaults";
import { resolveNewThreadRuntimeMode } from "./thread-settings-options";
import { resolveProjectThreadCreationBranch } from "./projectThreadCreationValidation";
import {
  INACTIVE_FLOW_KEY,
  type NewTaskFlowState,
  newTaskFlowStateAtom,
  readNewTaskFlowState,
  resolveRouteDraft,
  type RouteDraftResolution,
  stampedEnvironmentProjectsLoading,
  updateNewTaskFlowState,
} from "./new-task-flow-state";
import { useEnvironmentShellReadiness } from "../../state/shell";
import { useConnectionsReady, useWorkspaceEnvironments } from "../../state/workspace";

export function branchBadgeLabel(input: {
  readonly branch: VcsRef;
  readonly project: EnvironmentProject | null;
}): string | null {
  if (input.branch.current) {
    return "current";
  }
  if (input.branch.worktreePath && input.branch.worktreePath !== input.project?.workspaceRoot) {
    return "worktree";
  }
  if (input.branch.isRemote) {
    return "remote";
  }
  if (input.branch.isDefault) {
    return "default";
  }
  return null;
}

type NewTaskFlowContextValue = {
  readonly activeNewTask: { readonly pendingKey: string | null } | null;
  readonly projectScopes: ReadonlyArray<HomeProjectScope>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly selectedModelKey: string | null;
  readonly workspaceMode: NewTaskWorkspaceMode;
  readonly isGitRepo: boolean;
  readonly isGitRepoKnown: boolean;
  readonly canChooseWorkspace: boolean;
  /** The selected project is a workspace: its tasks start in new worktrees or the cloud. */
  readonly isWorkspace: boolean;
  /** The selected project's Cloud entry: its own Pair Cloud, a routed one, or not offered. */
  readonly cloud: NewTaskCloud;
  /** The project's own environment is a Pair Cloud, so Cloud is its only mode. */
  readonly cloudLaunch: boolean;
  /** Where the task launches: a routed Cloud draft launches on the matching Pair Cloud project. */
  readonly launch: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly serverConfig: ServerConfig | null;
  } | null;
  /** The selected branch's check before a routed Cloud send; `block` stops the send. */
  readonly cloudBranch: CloudBranchCheck | null;
  readonly selectedBranchName: string | null;
  readonly selectedWorktreePath: string | null;
  readonly resolveWorkspaceSelection: (
    selection: ComposerDraftWorkspaceSelection | undefined,
  ) => ComposerDraftWorkspaceSelection;
  readonly startFromOrigin: boolean;
  readonly pullRequestReference: string | undefined;
  readonly draftKey: string | null;
  readonly prompt: string;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly submitting: boolean;
  readonly branchesLoading: boolean;
  readonly availableBranches: ReadonlyArray<VcsRef>;
  readonly currentCheckoutBranchName: string | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly planModeEnabled: boolean;
  readonly expandedProvider: string | null;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
  }>;
  readonly selectedProject: EnvironmentProject | null;
  /** The machines the selected project's environment links to, whose threads it can read. */
  readonly linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
  readonly isScratchDraft: boolean;
  readonly modelOptions: ReadonlyArray<ModelOption>;
  readonly selectedModel: ModelSelection | null;
  readonly selectedModelOption: ModelOption | null;
  readonly selectedProviderStatus: ServerProvider | null;
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly setProject: (project: EnvironmentProject) => void;
  /** The flow's project, read when a continuation resumes after an await. */
  readonly getSelectedProjectKey: () => string | null;
  /**
   * The draft id of the route this flow serves when that draft, or its
   * project, is gone. Only the topmost draft route is served, so a screen
   * compares this with its own draft id.
   */
  readonly missingRouteDraftId: string | null;
  readonly selectEnvironment: (environmentId: EnvironmentId) => void;
  readonly switchEnvironment: (environmentId: EnvironmentId) => Promise<boolean>;
  readonly switchingToEnvironmentId: EnvironmentId | null;
  readonly setSelectedModelKey: (
    key: string | null,
    options?: ReadonlyArray<ProviderOptionSelection>,
  ) => void;
  /** `cloudEnvironmentId` picks among several Pair Clouds. */
  readonly setWorkspaceMode: (
    mode: NewTaskWorkspaceMode,
    cloudEnvironmentId?: EnvironmentId,
  ) => void;
  readonly selectBranch: (branch: VcsRef) => void;
  readonly setStartFromOrigin: (value: boolean) => void;
  readonly buildPendingTaskMessage: (
    metadata: TurnCommandMetadata,
    options?: {
      readonly currentCheckoutBranch?: string | null;
    },
  ) => QueuedThreadMessage | null;
  readonly setPrompt: (value: string) => void;
  readonly replaceAttachments: (attachments: ReadonlyArray<DraftComposerAttachment>) => void;
  /** Appends draft attachments; returns how many the live cap rejected. */
  readonly appendAttachments: (
    attachments: ReadonlyArray<DraftComposerAttachment>,
    insertion?: ComposerDraftInsertion,
  ) => number;
  readonly removeAttachment: (imageId: string) => void;
  readonly clearAttachments: () => void;
  readonly setSubmitting: (value: boolean) => void;
  readonly loadBranches: () => void;
  readonly setRuntimeMode: (value: RuntimeMode) => void;
  readonly setInteractionMode: (value: ProviderInteractionMode) => void;
  readonly setSelectedModelOptions: (
    value: ReadonlyArray<ProviderOptionSelection> | undefined,
  ) => void;
  readonly setExpandedProvider: (value: string | null) => void;
};

const NewTaskFlowContext = React.createContext<NewTaskFlowContextValue | null>(null);

export function NewTaskFlowProvider(
  props: React.PropsWithChildren<{
    active?: boolean;
    /** Identifies the draft route this flow serves; a new key starts a fresh flow. */
    flowKey?: string;
    routeDraftId?: string;
  }>,
) {
  const projects = useProjects();
  const threads = useThreadShells();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const groupingSettings = useMobileProjectGroupingSettings();
  const { enabled: legacyPlanModeEnabled } = useLegacyPlanModeState();

  const projectScopes = sortHomeProjectScopes({
    scopes: buildHomeProjectScopes({
      projects,
      environmentId: null,
      projectGroupingMode: groupingSettings.sidebarProjectGroupingMode,
    }),
    threads,
    pendingTasks: [],
    projectSortOrder: "updated_at",
  });

  const flowKey = props.flowKey ?? INACTIVE_FLOW_KEY;
  const storedFlowState = useAtomValue(newTaskFlowStateAtom(flowKey));
  const draftsLoaded = useAtomValue(composerDraftsLoadedAtom);
  // A draft route opened from a list row, a deep link, or restored state binds
  // its draft here until the flow's first write stores the binding.
  const routeDraft = useComposerDraft(
    storedFlowState.draftKey === null ? (props.routeDraftId ?? null) : null,
  );
  // Readiness of the environment the route's draft is stamped to; another
  // environment's projects loading first says nothing about it.
  const stampedEnvironmentId = routeDraft.project?.environmentId ?? null;
  const connectionsReady = useConnectionsReady();
  const stampedEnvironmentConnection =
    useWorkspaceEnvironments().find(
      (environment) => environment.environmentId === stampedEnvironmentId,
    )?.connectionState ?? null;
  const stampedEnvironmentShell = useEnvironmentShellReadiness(stampedEnvironmentId);
  const stampedEnvironmentLoading = stampedEnvironmentProjectsLoading({
    connectionsReady,
    connectionState: stampedEnvironmentConnection,
    shellCacheRead: stampedEnvironmentShell.cacheRead,
    shellStatus: stampedEnvironmentShell.status,
    shellHasError: stampedEnvironmentShell.hasError,
  });
  const resolveRoute = (
    flow: NewTaskFlowState,
    loaded: boolean,
    stamp: Parameters<typeof resolveRouteDraft>[0]["stamp"],
  ): RouteDraftResolution =>
    resolveRouteDraft({
      flow,
      routeDraftId: props.routeDraftId,
      draftsLoaded: loaded,
      stamp,
      projects,
      stampedEnvironmentLoading,
    });
  const routeDraftResolution = resolveRoute(storedFlowState, draftsLoaded, routeDraft.project);
  const flowState =
    routeDraftResolution.kind === "open" ? routeDraftResolution.flow : storedFlowState;
  const {
    environmentId: selectedEnvironmentIdOverride,
    projectKey: selectedProjectKey,
    draftKey: activeDraftKey,
    submitting,
    expandedProvider,
  } = flowState;
  // Continuations read the flow at use time, with the route's draft applied.
  const readFlow = (): NewTaskFlowState => {
    const stored = readNewTaskFlowState(flowKey);
    const resolution = resolveRoute(
      stored,
      appAtomRegistry.get(composerDraftsLoadedAtom),
      props.routeDraftId === undefined
        ? undefined
        : getComposerDraftSnapshot(props.routeDraftId).project,
    );
    return resolution.kind === "open" ? resolution.flow : stored;
  };
  // Every flow write stores the route's draft binding along with it, so the
  // binding outlives the draft's project stamp (submit clears it).
  const updateFlow = (patch: Partial<NewTaskFlowState>) =>
    updateNewTaskFlowState(flowKey, { ...readFlow(), ...patch });
  const selectedEnvironmentId =
    selectedEnvironmentIdOverride !== null &&
    projects.some((project) => project.environmentId === selectedEnvironmentIdOverride)
      ? selectedEnvironmentIdOverride
      : (projects[0]?.environmentId ?? null);
  const projectsForEnvironment = pipe(
    projects,
    Arr.filter((project) => project.environmentId === selectedEnvironmentId),
  );

  // A route draft still waiting for its environment has no project yet: the
  // fallback would show, and could send to, another environment's project.
  const selectedProject =
    routeDraftResolution.kind === "pending"
      ? null
      : (projectsForEnvironment.find(
          (project) => scopedProjectKey(project.environmentId, project.id) === selectedProjectKey,
        ) ??
        projectsForEnvironment[0] ??
        null);

  const storedStickyModelSelection = useStickyComposerModelSelection();
  const modelSelectionNow = useNowMinuteMs();
  const selectedProjectDraftKey = selectedProject ? activeDraftKey : null;
  const selectedProjectDraft = useComposerDraft(selectedProjectDraftKey);
  const projectDefaults = useNewTaskProjectDefaults(
    selectedProject,
    selectedProjectDraft.workspaceSelection?.cloudEnvironmentId,
  );
  const selectedEnvironmentServerConfig = projectDefaults.serverConfig;
  const isScratchDraft = projectDefaults.isScratch;
  // A workspace's own folder is not a repository: its tasks start in new worktrees of each one.
  const isWorkspace = projectDefaults.workspace;
  const serverConfigs = useServerConfigs();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- creates the persistent draft in the new-task flow store once a project is selected, before the composer mounts
  useEffect(() => {
    // A route that names a draft binds that draft, or returns to the picker.
    if (
      props.active === false ||
      props.routeDraftId !== undefined ||
      activeDraftKey !== null ||
      selectedProject === null
    ) {
      return;
    }
    // Creates the persistent draft once the project selection is ready; the key must exist before the composer mounts.
    updateNewTaskFlowState(flowKey, {
      draftKey: createNewTaskDraft({
        environmentId: selectedProject.environmentId,
        projectId: selectedProject.id,
      }),
    });
  }, [activeDraftKey, flowKey, selectedProject, props.active, props.routeDraftId]);
  const activePendingKey =
    props.active === false
      ? null
      : props.routeDraftId
        ? `draft-task:${props.routeDraftId}`
        : selectedProjectDraftKey
          ? `draft-task:${selectedProjectDraftKey}`
          : null;
  const activeNewTask = props.active === false ? null : { pendingKey: activePendingKey };
  const prompt = selectedProjectDraft.text;
  const attachments = selectedProjectDraft.attachments;
  const projectGitStatus = useEnvironmentQuery(
    props.active !== false &&
      selectedProject !== null &&
      selectedProject.workspaceRoot !== "" &&
      !isWorkspace
      ? vcsEnvironment.status({
          environmentId: selectedProject.environmentId,
          input: { cwd: selectedProject.workspaceRoot },
        })
      : null,
  );
  const currentCheckoutBranchName = projectGitStatus.data?.refName ?? null;
  // The unfiltered ref list also provides repository capability while offline.
  const projectBranches = useBranches({
    environmentId: selectedProject?.environmentId ?? null,
    cwd: isWorkspace ? null : selectedProject?.workspaceRoot || null,
  });
  // A workspace counts as one here so its new worktrees are not refused as a plain folder's.
  const knownIsGitRepo = isWorkspace
    ? true
    : (projectGitStatus.data?.isRepo ?? projectBranches.data?.isRepo ?? null);
  const isGitRepo = knownIsGitRepo ?? true;
  const projectSettings = projectDefaults.projectSettings;
  const canChooseWorkspace = !isScratchDraft && !isWorkspace;
  const defaultWorkspaceMode: NewTaskWorkspaceMode = projectDefaults.defaultWorkspaceMode;
  const branchState = usePaginatedBranches({
    environmentId: selectedProject?.environmentId ?? null,
    cwd: isWorkspace ? null : selectedProject?.workspaceRoot || null,
  });
  const branchesLoading = branchState.isPending && branchState.data === null;
  const allBranchRefs = branchState.refs;
  const availableBranches = pipe(
    allBranchRefs,
    Arr.filter((branch) => !branch.isRemote),
  );

  const resolveWorkspaceSelection = (selection: ComposerDraftWorkspaceSelection | undefined) =>
    resolveNewTaskDraftWorkspace({
      selection,
      canChooseWorkspace,
      defaultMode: defaultWorkspaceMode,
      defaultModeSettled: projectDefaults.defaultWorkspaceModeSettled,
      isGitRepo,
      cloudAvailable: projectDefaults.cloud.available,
      cloudLaunch: projectDefaults.cloudLaunch,
      workspace: isWorkspace,
      branches: allBranchRefs,
      projectCwd: selectedProject?.workspaceRoot ?? null,
    });
  const workspaceSelection = resolveWorkspaceSelection(selectedProjectDraft.workspaceSelection);
  const workspaceMode = workspaceSelection.mode;
  const selectedBranchName = workspaceSelection.branch;
  const selectedWorktreePath = workspaceSelection.worktreePath;
  const cloudRoute =
    workspaceMode === "cloud" && projectDefaults.cloud.routed ? projectDefaults.cloud.target : null;
  // Models, uploads, the team viewer and linked threads all come from where the task launches.
  const launchEnvironmentId = cloudRoute?.environmentId ?? selectedProject?.environmentId ?? null;
  const launchProjectId = cloudRoute?.projectId ?? selectedProject?.id ?? null;
  const routedServerConfig = useEnvironmentServerConfig(cloudRoute?.environmentId ?? null);
  const launchServerConfig = cloudRoute ? routedServerConfig : selectedEnvironmentServerConfig;
  const launch =
    launchEnvironmentId && launchProjectId
      ? {
          environmentId: launchEnvironmentId,
          projectId: launchProjectId,
          serverConfig: launchServerConfig,
        }
      : null;
  const linkedEnvironments = useLinkedEnvironments(launchEnvironmentId);
  const teamViewer = useTeamViewer(launchEnvironmentId);
  // A workspace has no branch to check: each repository starts from its own default branch.
  const routedBranch = cloudRoute && !isWorkspace ? selectedBranchName : null;
  const routedBranchRefs = useBranches({
    environmentId: routedBranch !== null && selectedProject ? selectedProject.environmentId : null,
    cwd: routedBranch !== null ? selectedProject?.workspaceRoot || null : null,
    query: routedBranch,
  });
  const routedDefaultBranchRef = allBranchRefs.find((branch) => branch.isDefault) ?? null;
  const routedDefaultBranch = routedDefaultBranchRef
    ? resolveNewTaskBaseBranchName("cloud", routedDefaultBranchRef)
    : selectedBranchName;
  const cloudBranch =
    routedBranch !== null
      ? cloudBranchCheck({
          branch: routedBranch,
          ref:
            routedBranchRefs.data?.refs.find(
              (branch) => !branch.isRemote && branch.name === routedBranch,
            ) ?? null,
          status: projectGitStatus.data ?? null,
        })
      : null;
  // Keep the user's explicit choice separate from the resolved display value:
  // only the explicit flag is ever written back to the draft, so the resolved
  // value keeps tracking the server setting when the config loads late.
  const draftStartFromOrigin = selectedProjectDraft.workspaceSelection?.startFromOrigin;
  const startFromOrigin =
    isGitRepo && (draftStartFromOrigin ?? projectSettings.settings.newWorktreesStartFromOrigin);
  const defaultRuntimeMode = projectSettings.settings.defaultRuntimeMode;
  const managedPolicy = launchServerConfig?.managedPolicy;
  const runtimeMode = resolveNewThreadRuntimeMode(
    selectedProjectDraft.runtimeMode,
    defaultRuntimeMode,
    managedPolicy,
  );

  // Antigravity keeps unavailable selections so sign-out or a catalog change
  // cannot switch the user's model.
  const draftModelSelection = resolveSelectableModelSelection(
    launchServerConfig,
    selectedProjectDraft.modelSelection ?? null,
    launchProjectId,
  );
  const configuredDefaultModelSelection = resolveDefaultableModelSelection(
    launchServerConfig,
    projectSettings.settings.defaultModelSelection,
    launchProjectId,
  );
  const storedDefaultModelSelection = resolveDefaultableModelSelection(
    launchServerConfig,
    storedStickyModelSelection,
    launchProjectId,
  );
  // On a team, a new task starts on the creator's own account and never on a teammate's.
  const teamModelSelection =
    teamViewer !== null && draftModelSelection === null && launchServerConfig
      ? resolveTeamNewThreadModelSelection({
          selection: configuredDefaultModelSelection ?? storedDefaultModelSelection,
          providers: launchServerConfig.providers,
          settings: launchServerConfig.settings,
          projectId: launchProjectId,
          memberId: teamViewer.memberId,
        })
      : null;
  const projectDefaultModelSelection = teamModelSelection ?? configuredDefaultModelSelection;
  const stickyModelSelection = teamModelSelection === null ? storedDefaultModelSelection : null;
  const modelOptions = withCloudModelReasons(
    filterModelOptionsForViewer(
      buildModelOptions(
        launchServerConfig,
        draftModelSelection ?? projectDefaultModelSelection ?? stickyModelSelection,
        undefined,
        launchProjectId,
      ),
      {
        settings: launchServerConfig?.settings,
        viewer: teamViewer,
        currentInstanceId: undefined,
      },
    ),
    workspaceMode === "cloud" && launchServerConfig ? launchServerConfig : null,
  );

  const selectedDefaultModel = resolveNewTaskModelSelection({
    draftSelection: draftModelSelection,
    projectDefaultSelection: projectDefaultModelSelection,
    stickySelection: stickyModelSelection,
    modelOptions,
  });
  const selectedModel = resolveNewThreadModelSelection({
    defaultSelection: selectedDefaultModel,
    explicitSelection:
      draftModelSelection ?? (projectDefaultModelSelection ? null : stickyModelSelection),
    fallbackSelection: launchServerConfig?.settings.fallbackModelSelection ?? null,
    providers: launchServerConfig?.providers ?? [],
    ...(launchServerConfig ? { settings: launchServerConfig.settings } : {}),
    projectId: launchProjectId,
    now: modelSelectionNow,
  }).selection;
  const selectedModelKey = selectedModel
    ? `${selectedModel.instanceId}:${selectedModel.model}`
    : null;

  const selectedModelOption =
    modelOptions.find(
      (option) =>
        selectedModel &&
        option.selection.instanceId === selectedModel.instanceId &&
        option.selection.model === selectedModel.model,
    ) ?? null;
  const selectedProviderStatus =
    launchServerConfig?.providers.find(
      (provider) => provider.instanceId === selectedModel?.instanceId,
    ) ?? null;
  const planModeEnabled =
    legacyPlanModeEnabled && selectedProviderStatus?.showInteractionModeToggle !== false;
  const interactionMode = planModeEnabled
    ? (selectedProjectDraft.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE)
    : DEFAULT_PROVIDER_INTERACTION_MODE;
  const setSelectedModelKey = (
    key: string | null,
    options?: ReadonlyArray<ProviderOptionSelection>,
  ) => {
    if (!key || !selectedProjectDraftKey) {
      return;
    }
    const option = modelOptions.find((candidate) => candidate.key === key);
    if (!option) {
      return;
    }
    const selection = withRememberedModelOptions(
      options ? { ...option.selection, options } : option.selection,
    );
    const provider = launchServerConfig?.providers.find(
      (candidate) => candidate.instanceId === selection.instanceId,
    );
    updateComposerDraftSettings(selectedProjectDraftKey, {
      modelSelection: selection,
      ...(provider?.showInteractionModeToggle === false
        ? { interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE }
        : {}),
    });
    setStickyComposerModelSelection(selection);
  };
  const setSelectedModelOptions = (options: ReadonlyArray<ProviderOptionSelection> | undefined) => {
    if (!selectedModel || !selectedProjectDraftKey) {
      return;
    }
    rememberModelOptions(selectedModel.instanceId, selectedModel.model, options ?? []);
    const nextSelection: ModelSelection = options
      ? { ...selectedModel, options }
      : {
          instanceId: selectedModel.instanceId,
          model: selectedModel.model,
        };
    updateComposerDraftSettings(selectedProjectDraftKey, {
      modelSelection: nextSelection,
    });
    setStickyComposerModelSelection(nextSelection);
  };

  const providerGroups = groupByProvider(modelOptions);
  const setPrompt = (value: string) => {
    if (!selectedProjectDraftKey) {
      return;
    }
    setComposerDraftText(selectedProjectDraftKey, value);
  };
  const replaceAttachments = (nextAttachments: ReadonlyArray<DraftComposerAttachment>) => {
    if (!selectedProjectDraftKey) {
      return;
    }
    replaceComposerDraftAttachments(selectedProjectDraftKey, nextAttachments);
  };
  const appendAttachments = (
    nextAttachments: ReadonlyArray<DraftComposerAttachment>,
    insertion?: ComposerDraftInsertion,
  ): number => {
    if (!selectedProjectDraftKey) {
      return 0;
    }
    return appendComposerDraftAttachments(selectedProjectDraftKey, nextAttachments, {
      appendReference: true,
      insertion,
    });
  };
  const removeAttachment = (imageId: string) => {
    if (!selectedProjectDraftKey) {
      return;
    }
    removeComposerDraftAttachment(selectedProjectDraftKey, imageId);
  };
  const clearAttachments = () => {
    if (!selectedProjectDraftKey) {
      return;
    }
    replaceComposerDraftAttachments(selectedProjectDraftKey, []);
  };

  const carryDraftContentTo = (project: EnvironmentProject): string => {
    const target = { environmentId: project.environmentId, projectId: project.id };
    const current = readFlow().draftKey;
    if (current !== null && isNewTaskDraftKey(current)) {
      retargetNewTaskDraft(current, target);
      return current;
    }
    return createNewTaskDraft(target);
  };

  const setProject = (project: EnvironmentProject) => {
    updateFlow({
      draftKey: carryDraftContentTo(project),
      environmentId: project.environmentId,
      projectKey: scopedProjectKey(project.environmentId, project.id),
    });
  };

  const selectEnvironment = (environmentId: EnvironmentId) => {
    const match = resolveEnvironmentProjectMatch(
      projects.filter((project) => project.environmentId === environmentId),
      selectedProject,
    );
    updateFlow({
      draftKey: match ? carryDraftContentTo(match) : readFlow().draftKey,
      environmentId,
      projectKey: match ? scopedProjectKey(match.environmentId, match.id) : null,
    });
  };

  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });
  const [switchingToEnvironmentId, setSwitchingToEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const latestSwitchRef = useRef<object | null>(null);
  const switchEnvironment = async (environmentId: EnvironmentId): Promise<boolean> => {
    if (environmentId === selectedEnvironmentId) {
      latestSwitchRef.current = null;
      setSwitchingToEnvironmentId(null);
      return true;
    }
    if (!isScratchDraft) {
      selectEnvironment(environmentId);
      return true;
    }
    const request = {};
    latestSwitchRef.current = request;
    setSwitchingToEnvironmentId(environmentId);
    const result = await openScratch({ environmentId, input: {} });
    if (latestSwitchRef.current !== request) return false;
    latestSwitchRef.current = null;
    setSwitchingToEnvironmentId(null);
    if (result._tag === "Success") {
      setProject(result.value);
      return true;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        "Could not switch machine",
        error instanceof Error
          ? error.message
          : "The folder for threads without a project could not be created.",
      );
    }
    return false;
  };

  const setWorkspaceMode = (mode: NewTaskWorkspaceMode, cloudEnvironmentId?: EnvironmentId) => {
    if (!selectedProjectDraftKey) {
      return;
    }
    if (!selectedProject) {
      return;
    }
    const localSelection = resolveNewTaskLocalWorkspaceSelection({
      branches: availableBranches,
      projectCwd: selectedProject.workspaceRoot,
    });
    updateComposerDraftSettings(selectedProjectDraftKey, {
      workspaceSelection: {
        mode,
        branch: mode === "local" ? localSelection.branch : selectedBranchName,
        worktreePath:
          mode === "local"
            ? localSelection.worktreePath
            : mode === "cloud"
              ? null
              : selectedWorktreePath,
        ...(draftStartFromOrigin !== undefined ? { startFromOrigin: draftStartFromOrigin } : {}),
        // Refs have not named the current branch yet; the selection follows it.
        ...(mode === "local" && localSelection.awaitsCurrentBranch
          ? { followsCurrentCheckout: true }
          : {}),
        ...(mode === "cloud" && cloudEnvironmentId ? { cloudEnvironmentId } : {}),
      },
    });
  };
  const pickedCloudEnvironmentId = selectedProjectDraft.workspaceSelection?.cloudEnvironmentId;
  const keepsCloudPick =
    workspaceMode === "cloud" && pickedCloudEnvironmentId
      ? { cloudEnvironmentId: pickedCloudEnvironmentId }
      : {};

  const selectBranch = (branch: VcsRef) => {
    if (!selectedProject || !selectedProjectDraftKey) {
      return;
    }
    updateComposerDraftSettings(selectedProjectDraftKey, {
      workspaceSelection: {
        mode: workspaceMode,
        branch: resolveNewTaskBaseBranchName(workspaceMode, branch),
        worktreePath: resolveNewTaskBranchWorktreePath({
          workspaceMode,
          projectCwd: selectedProject.workspaceRoot,
          branchWorktreePath: branch.worktreePath,
        }),
        ...(draftStartFromOrigin !== undefined ? { startFromOrigin: draftStartFromOrigin } : {}),
        ...keepsCloudPick,
      },
    });
  };

  const setStartFromOrigin = (value: boolean) => {
    if (!selectedProjectDraftKey) {
      return;
    }
    updateComposerDraftSettings(selectedProjectDraftKey, {
      workspaceSelection: {
        mode: workspaceMode,
        branch: selectedBranchName,
        worktreePath: selectedWorktreePath,
        startFromOrigin: value,
        ...(selectedBranchName === null && workspaceSelection.followsCurrentCheckout
          ? { followsCurrentCheckout: true }
          : {}),
        ...keepsCloudPick,
      },
    });
  };

  const refreshBranches = branchState.refresh;
  const loadBranches = () => {
    if (!selectedProject) {
      return;
    }
    setPendingConnectionError(null);
    refreshBranches();
  };

  const setRuntimeMode = (value: RuntimeMode) => {
    if (selectedProjectDraftKey) {
      updateComposerDraftSettings(selectedProjectDraftKey, { runtimeMode: value });
    }
  };
  const setInteractionMode = (value: ProviderInteractionMode) => {
    if (selectedProjectDraftKey) {
      updateComposerDraftSettings(selectedProjectDraftKey, {
        interactionMode: resolveProviderInteractionMode(selectedProviderStatus, value),
      });
    }
  };

  const buildPendingTaskMessage = (
    metadata: TurnCommandMetadata,
    options?: { readonly currentCheckoutBranch?: string | null },
  ): QueuedThreadMessage | null => {
    if (!selectedProject || !selectedProjectDraftKey || !launch) {
      return null;
    }
    const draft = getComposerDraftSnapshot(selectedProjectDraftKey);
    const text = draft.text.trim();
    const workspaceSelection = resolveWorkspaceSelection(draft.workspaceSelection);
    const mode = workspaceSelection.mode;
    const route = mode === "cloud" && projectDefaults.cloud.routed;
    // Models and policy below were resolved for `launch`; a draft that moved since then waits.
    if (route !== (launch.environmentId !== selectedProject.environmentId)) return null;
    const draftModelSelection =
      resolveSelectableModelSelection(
        launchServerConfig,
        draft.modelSelection ?? null,
        launch.projectId,
      ) ?? selectedModel;
    if ((text.length === 0 && draft.attachments.length === 0) || !draftModelSelection) {
      return null;
    }
    if (
      threadContextsOutsideEnvironment({
        text: draft.text,
        records: draft.context?.records ?? [],
        environmentId: launch.environmentId,
        linkedEnvironments,
      }).length > 0
    ) {
      return null;
    }
    const branch = resolveProjectThreadCreationBranch({
      workspaceMode: mode,
      selectedBranch: workspaceSelection?.branch ?? null,
      currentCheckoutBranch: options?.currentCheckoutBranch ?? null,
    });
    const launchProject = route
      ? projects.find(
          (project) =>
            project.environmentId === launch.environmentId && project.id === launch.projectId,
        )
      : selectedProject;
    return {
      environmentId: launch.environmentId,
      threadId: ThreadId.make(metadata.threadId),
      messageId: MessageId.make(metadata.messageId),
      commandId: CommandId.make(metadata.commandId),
      text,
      attachments: draft.attachments,
      context: draft.context,
      modelSelection: draftModelSelection,
      runtimeMode: resolveNewThreadRuntimeMode(
        draft.runtimeMode,
        defaultRuntimeMode,
        managedPolicy,
      ),
      interactionMode: resolvePendingTaskInteractionMode({
        planModeEnabled: legacyPlanModeEnabled,
        draftInteractionMode: draft.interactionMode,
        provider: launchServerConfig?.providers.find(
          (candidate) => candidate.instanceId === draftModelSelection.instanceId,
        ),
      }),
      creation: {
        projectId: launch.projectId,
        projectTitle: launchProject?.title ?? selectedProject.title,
        ...(launchProject ? { projectCwd: launchProject.workspaceRoot } : {}),
        workspaceMode: mode,
        ...(isWorkspace ? { workspace: true } : {}),
        ...(mode === "worktree" && workspaceSelection?.pullRequestReference
          ? { pullRequestReference: workspaceSelection.pullRequestReference }
          : {}),
        // Queued local tasks use drain-time checkout; snapshot branches only for immediate sends or explicit choices.
        branch,
        worktreePath: mode === "local" ? (workspaceSelection?.worktreePath ?? null) : null,
        ...((workspaceSelection?.startFromOrigin ?? startFromOrigin)
          ? { startFromOrigin: true }
          : {}),
        ...(route && branch !== null
          ? {
              routedFrom: {
                environmentId: selectedProject.environmentId,
                projectId: selectedProject.id,
                defaultBranch: isWorkspace ? branch : (routedDefaultBranch ?? branch),
              },
            }
          : {}),
      },
      createdAt: metadata.createdAt,
    };
  };

  // Pair Cloud runs only cloud threads: a task there stays there, and other tasks leave it out.
  const selectedOnPairCloud =
    selectedProject !== null &&
    isCloudLaunchEnvironment(serverConfigs.get(selectedProject.environmentId) ?? null);
  const offersLocalModes = (environmentId: EnvironmentId) =>
    environmentId === selectedProject?.environmentId ||
    (!selectedOnPairCloud && !isCloudLaunchEnvironment(serverConfigs.get(environmentId) ?? null));
  const scratchEnvironments = connectedEnvironments.filter(
    (environment) =>
      offersLocalModes(environment.environmentId) &&
      availableScratchWorkspaceRoot(
        environment.connectionState,
        serverConfigs.get(environment.environmentId),
      ) !== null,
  );

  const selectedRepositoryKey = selectedProject?.repositoryIdentity
    ? repositoryGroupingKeyOf(selectedProject.repositoryIdentity)
    : null;
  // Use || null: placeholder workspaceRoot can be empty, and an empty basename rejects real hosts.
  const selectedWorkspaceBasename = selectedProject?.workspaceRoot.split("/").at(-1) || null;
  const selectedProjectTitle = selectedProject?.title ?? null;
  const environments = (() => {
    if (isScratchDraft) {
      return scratchEnvironments.map((environment) => ({
        environmentId: environment.environmentId,
        environmentLabel: environment.environmentLabel,
      }));
    }
    const seen = new Set<EnvironmentId>();
    const result: Array<{
      readonly environmentId: EnvironmentId;
      readonly environmentLabel: string;
    }> = [];
    const hostsSelectedRepository = (project: EnvironmentProject) => {
      if (selectedRepositoryKey === null && selectedWorkspaceBasename === null) {
        return true;
      }
      const projectKey = project.repositoryIdentity
        ? repositoryGroupingKeyOf(project.repositoryIdentity)
        : null;
      if (selectedRepositoryKey !== null && projectKey !== null) {
        return projectKey === selectedRepositoryKey;
      }
      return (
        project.workspaceRoot.split("/").at(-1) === selectedWorkspaceBasename ||
        (selectedProjectTitle !== null && project.title === selectedProjectTitle)
      );
    };
    for (const project of projects) {
      if (!hostsSelectedRepository(project)) {
        continue;
      }
      if (seen.has(project.environmentId) || !offersLocalModes(project.environmentId)) {
        continue;
      }
      // A workspace's repositories are projects on its own environment.
      if (isWorkspace && project.environmentId !== selectedProject?.environmentId) continue;
      const environment = savedConnectionsById[project.environmentId];
      if (!environment) {
        continue;
      }
      seen.add(project.environmentId);
      result.push({
        environmentId: project.environmentId,
        environmentLabel: environment.environmentLabel,
      });
    }
    return result;
  })();

  const value = {
    activeNewTask,
    projectScopes,
    selectedEnvironmentId,
    selectedProjectKey,
    selectedModelKey,
    workspaceMode,
    isGitRepo,
    isGitRepoKnown: knownIsGitRepo !== null,
    canChooseWorkspace,
    isWorkspace,
    cloud: projectDefaults.cloud,
    cloudLaunch: projectDefaults.cloudLaunch,
    launch,
    cloudBranch,
    selectedBranchName,
    selectedWorktreePath,
    resolveWorkspaceSelection,
    startFromOrigin,
    draftKey: selectedProjectDraftKey,
    pullRequestReference: selectedProjectDraft.workspaceSelection?.pullRequestReference,
    prompt,
    attachments,
    submitting,
    branchesLoading,
    availableBranches,
    currentCheckoutBranchName,
    runtimeMode,
    interactionMode,
    planModeEnabled,
    expandedProvider,
    environments,
    selectedProject,
    linkedEnvironments,
    isScratchDraft,
    modelOptions,
    selectedModel,
    selectedModelOption,
    selectedProviderStatus,
    providerGroups,
    setProject,
    getSelectedProjectKey: () => readFlow().projectKey,
    missingRouteDraftId:
      routeDraftResolution.kind === "missing" ? (props.routeDraftId ?? null) : null,
    selectEnvironment,
    switchEnvironment,
    switchingToEnvironmentId,
    setSelectedModelKey,
    setWorkspaceMode,
    selectBranch,
    setStartFromOrigin,
    buildPendingTaskMessage,
    setPrompt,
    replaceAttachments,
    appendAttachments,
    removeAttachment,
    clearAttachments,
    setSubmitting: (value: boolean) => updateFlow({ submitting: value }),
    loadBranches,
    setRuntimeMode,
    setInteractionMode,
    setSelectedModelOptions,
    setExpandedProvider: (value: string | null) => updateFlow({ expandedProvider: value }),
  } satisfies NewTaskFlowContextValue;

  return (
    <ActiveNewTaskContext value={activeNewTask}>
      <NewTaskFlowContext.Provider value={value}>{props.children}</NewTaskFlowContext.Provider>
    </ActiveNewTaskContext>
  );
}

export function useNewTaskFlow() {
  const value = React.use(NewTaskFlowContext);
  if (value === null) {
    throw new Error("useNewTaskFlow must be used within NewTaskFlowProvider.");
  }
  return value;
}
