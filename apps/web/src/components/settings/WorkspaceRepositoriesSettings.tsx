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
import { InfoIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useProjects } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { SettingsFooter, SettingsRow, SettingsSection } from "./settingsLayout";

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

  const projectOf = (projectId: ProjectId) =>
    projects.find(
      (project) => project.environmentId === workspace.environmentId && project.id === projectId,
    );
  const titleOf = (projectId: ProjectId) => projectOf(projectId)?.title ?? "Missing project";
  const folderCounts = new Map<string, number>();
  for (const root of roots) {
    const key = root.name.trim().toLowerCase();
    folderCounts.set(key, (folderCounts.get(key) ?? 0) + 1);
  }
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

  const message = error ?? (changed ? problem : null);
  return (
    <SettingsSection id="workspace-repositories" title="Repositories">
      <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
        Each new thread gets a worktree of every repository, in a folder of the name below. Existing
        threads keep their repositories.
      </p>
      {roots.length > 0 ? (
        <div className="hidden items-center justify-between px-3 py-1.5 text-xs font-medium text-muted-foreground sm:flex sm:px-4">
          <span>Repository</span>
          <span className="mr-8 w-48">Folder name</span>
        </div>
      ) : null}
      {roots.map((root) => (
        <SettingsRow
          key={root.projectId}
          title={titleOf(root.projectId)}
          description={projectOf(root.projectId)?.workspaceRoot}
          control={
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <Input
                size="sm"
                font="mono"
                className="w-full sm:w-48"
                aria-label={`Folder name for ${titleOf(root.projectId)}`}
                aria-invalid={
                  (folderCounts.get(root.name.trim().toLowerCase()) ?? 0) > 1 || undefined
                }
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
                size="icon-xs"
                variant="ghost-destructive"
                aria-label={`Remove ${titleOf(root.projectId)}`}
                disabled={!canEdit || saving}
                onClick={() =>
                  edit(roots.filter((candidate) => candidate.projectId !== root.projectId))
                }
              >
                <XIcon />
              </Button>
            </div>
          }
        />
      ))}
      <SettingsFooter
        status={
          <>
            {addable.length > 0 ? (
              <Menu>
                <MenuTrigger
                  render={<Button size="sm" variant="outline" disabled={!canEdit || saving} />}
                >
                  <PlusIcon className="size-3.5" aria-hidden />
                  Add repository
                </MenuTrigger>
                <MenuPopup align="start">
                  {addable.map((project) => (
                    <MenuItem
                      key={project.id}
                      onClick={() =>
                        edit([
                          ...roots,
                          { projectId: project.id, name: defaultWorkspaceRepositoryName(project) },
                        ])
                      }
                    >
                      {project.title}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            ) : (
              <span>Every project on this machine is already here.</span>
            )}
            {message === null ? null : (
              <span role="alert" className="flex items-start gap-1.5 text-destructive-foreground">
                <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {message}
              </span>
            )}
          </>
        }
      >
        {changed ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={() => edit(workspace.roots)}
            >
              Discard
            </Button>
            <Button
              size="sm"
              disabled={!canEdit || saving || problem !== null}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </>
        ) : null}
      </SettingsFooter>
    </SettingsSection>
  );
}
