import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  defaultWorkspaceRepositoryName,
  workspaceRepositoriesProblem,
  workspaceRepositoryCandidates,
} from "@t3tools/client-runtime/state/workspaces";
import type { ProjectId, ProjectRoot } from "@t3tools/contracts";
import { useState } from "react";

import { useProjects } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Edits which repositories a workspace's new threads get, and their folder names. */
export function WorkspaceRepositoriesSettings({
  workspace,
  canEdit,
}: {
  workspace: SidebarProjectGroupMember & { readonly roots: ReadonlyArray<ProjectRoot> };
  canEdit: boolean;
}) {
  const projects = useProjects();
  const candidates = workspaceRepositoryCandidates(projects, workspace.environmentId);
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const [roots, setRoots] = useState<ReadonlyArray<ProjectRoot>>(workspace.roots);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleOf = (projectId: ProjectId) =>
    projects.find(
      (project) => project.environmentId === workspace.environmentId && project.id === projectId,
    )?.title ?? "Missing project";
  const problem = workspaceRepositoriesProblem(
    roots.map((root) => ({ name: root.name, title: titleOf(root.projectId) })),
  );
  const changed =
    roots.length !== workspace.roots.length ||
    roots.some(
      (root, index) =>
        root.projectId !== workspace.roots[index]?.projectId ||
        root.name.trim() !== workspace.roots[index]?.name,
    );
  const addable = candidates.filter(
    (project) => !roots.some((root) => root.projectId === project.id),
  );

  const edit = (next: ReadonlyArray<ProjectRoot>) => {
    setError(null);
    setRoots(next);
  };

  const save = async () => {
    if (!changed || problem !== null || saving) return;
    setSaving(true);
    setError(null);
    const result = await updateProject({
      environmentId: workspace.environmentId,
      input: {
        projectId: workspace.id,
        roots: roots.map((root) => ({ projectId: root.projectId, name: root.name.trim() })),
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Could not save the repositories.");
      }
      return;
    }
    toastManager.add({ type: "success", title: "Saved repositories" });
  };

  return (
    <SettingsSection id="workspace-repositories" title="Repositories">
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        Each new thread gets a worktree of every repository, in a folder of the name below. Existing
        threads keep their repositories.
      </p>
      {roots.map((root) => (
        <SettingsRow
          key={root.projectId}
          title={titleOf(root.projectId)}
          control={
            <div className="flex items-center gap-2">
              <Input
                size="sm"
                className="w-full sm:w-48"
                aria-label={`Folder name for ${titleOf(root.projectId)}`}
                disabled={!canEdit || saving}
                value={root.name}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) =>
                  edit(
                    roots.map((candidate) =>
                      candidate.projectId === root.projectId
                        ? { ...candidate, name: event.target.value }
                        : candidate,
                    ),
                  )
                }
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!canEdit || saving}
                onClick={() =>
                  edit(roots.filter((candidate) => candidate.projectId !== root.projectId))
                }
              >
                Remove
              </Button>
            </div>
          }
        />
      ))}
      <SettingsRow
        title="Add repository"
        description={addable.length === 0 ? "Every project on this machine is already here." : null}
        status={error ?? (changed ? problem : null)}
        control={
          <div className="flex items-center gap-2">
            {addable.length > 0 ? (
              <Select
                value={null}
                onValueChange={(value) => {
                  const project = addable.find((candidate) => candidate.id === value);
                  if (!project) return;
                  edit([
                    ...roots,
                    {
                      projectId: project.id,
                      name: defaultWorkspaceRepositoryName(project),
                    },
                  ]);
                }}
              >
                <SelectTrigger
                  size="sm"
                  aria-label="Add a repository"
                  disabled={!canEdit || saving}
                >
                  <SelectValue>{() => "Choose a project"}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {addable.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
            <Button
              size="sm"
              disabled={!canEdit || saving || !changed || problem !== null}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        }
      />
    </SettingsSection>
  );
}
