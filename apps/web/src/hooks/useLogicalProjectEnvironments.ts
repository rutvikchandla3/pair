import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";

import {
  type EnvironmentOption,
  resolveLogicalProjectEnvironments,
} from "../components/BranchToolbar.logic";
import { useProjects } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useClientSettings } from "./useSettings";

export function useLogicalProjectEnvironments(
  activeProject: EnvironmentProject | null,
  scratchDraft: boolean,
): readonly EnvironmentOption[] {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);

  if (!activeProject) return [];
  return resolveLogicalProjectEnvironments({
    activeProject,
    scratchDraft,
    environments,
    projects,
    primaryEnvironmentId,
    projectGroupingSettings,
  });
}
