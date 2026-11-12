import { resolveCloudTarget } from "@t3tools/client-runtime/state/cloud-target";
import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { isWorkspaceProject } from "@t3tools/client-runtime/state/workspaces";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectReadFileResult } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS, T3_PROJECT_FILE_NAME } from "@t3tools/contracts";
import { resolveNewThreadEnvMode, resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";

import type { NewTaskWorkspaceMode } from "../../lib/newTaskWorkspaceMode";
import { useEnvironmentServerConfig, useProjects, useServerConfigs } from "../../state/entities";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useProjectHasThreads } from "../../state/project-has-threads";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { environmentSession } from "../../state/session";
import { useIsTeamMode } from "../../state/team";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { NO_NEW_TASK_CLOUD, type NewTaskCloud, resolveNewTaskCloud } from "./new-task-cloud";

/**
 * A project's new-task defaults: server settings merged with its t3.json. The
 * new-task flow and the home pending-drafts list both read the default
 * workspace mode here, so a draft that never picked one shows what it sends.
 * Every read is a shared per-environment or per-project atom.
 */
export function useNewTaskProjectDefaults(
  project: EnvironmentProject | null,
  cloudEnvironmentId?: EnvironmentId,
) {
  const serverConfig = useEnvironmentServerConfig(project?.environmentId ?? null);
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const environments = useWorkspaceEnvironments();
  const isScratch =
    project !== null && isScratchProject(project, serverConfig?.scratchWorkspaceRoot);
  const workspace = isWorkspaceProject(project);
  const hasWorkspace = project !== null && project.workspaceRoot !== "";
  const fileAccessSession = useEnvironmentQuery(
    hasWorkspace ? environmentSession.sessionStateAtom(project.environmentId) : null,
  );
  const fileEnvironment = useEnvironmentPresentation(project?.environmentId ?? null);
  const fileAccess = resolveFilesystemReadAccess({
    isCatalogReady: fileEnvironment.isReady,
    connection: fileEnvironment.presentation?.connection ?? null,
    session: fileAccessSession.data,
    sessionError: fileAccessSession.error,
  });
  const fileAccessPending = hasWorkspace && fileAccess.isPending;
  const t3ProjectFileQuery = useEnvironmentQuery(
    fileAccess.canReadFiles && hasWorkspace
      ? projectEnvironment.readFile({
          environmentId: project.environmentId,
          input: {
            cwd: project.workspaceRoot,
            relativePath: T3_PROJECT_FILE_NAME,
            allowMissing: true,
          },
        })
      : null,
  );
  const t3ProjectFileData = t3ProjectFileQuery.data as ProjectReadFileResult | null;
  const t3ProjectFile =
    t3ProjectFileData === null || t3ProjectFileData.exists === false || t3ProjectFileData.truncated
      ? null
      : parseT3ProjectFile(t3ProjectFileData.contents);
  const projectSettings = resolveProjectSettings(
    serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
    project?.id ?? null,
    project,
    t3ProjectFile,
  );
  const projectHasThreads = useProjectHasThreads(project);
  const isTeamMode = useIsTeamMode(project?.environmentId ?? null);
  const cloudLaunch = serverConfig?.environment.capabilities.cloudLaunch === true;
  const cloud: NewTaskCloud =
    project === null
      ? NO_NEW_TASK_CLOUD
      : resolveNewTaskCloud({
          cloudTarget: resolveCloudTarget({
            project,
            environments: environments.map((environment) => ({
              environmentId: environment.environmentId,
              label: environment.environmentLabel,
              connected: environment.connectionState === "connected",
              serverConfig: serverConfigs.get(environment.environmentId) ?? null,
            })),
            projects,
          }),
          project,
          cloudEnvironmentId,
        });
  // A Pair Cloud project starts in the cloud; a routed one only when the user picks Cloud.
  const defaultWorkspaceMode: NewTaskWorkspaceMode = isScratch
    ? "local"
    : cloud.available && !cloud.routed
      ? "cloud"
      : workspace
        ? "worktree"
        : resolveNewThreadEnvMode({
            teamDefault: isTeamMode,
            projectSettings,
            workspaceRoot: project?.workspaceRoot ?? null,
            newProjectsRoot: serverConfig?.newProjectsRoot,
            projectHasThreads,
          });
  // While t3.json loads, the environment default is provisional; t3.json may replace it.
  const defaultWorkspaceModeSettled =
    workspace ||
    projectSettings.sources.defaultThreadEnvMode !== "environment" ||
    (!t3ProjectFileQuery.isPending && !fileAccessPending);
  return {
    serverConfig,
    isScratch,
    /** A workspace of several repositories: its tasks start in new worktrees or the cloud. */
    workspace,
    projectSettings,
    defaultWorkspaceMode,
    defaultWorkspaceModeSettled,
    /** Cloud for this project: on its own Pair Cloud, routed to a matching one, or not offered. */
    cloud,
    cloudLaunch,
  };
}
