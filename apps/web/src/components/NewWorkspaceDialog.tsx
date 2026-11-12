import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  MAX_WORKSPACE_REPOSITORIES,
  MIN_WORKSPACE_REPOSITORIES,
  defaultWorkspaceRepositoryName,
  workspaceRepositoriesProblem,
  workspaceRepositoryCandidates,
} from "@t3tools/client-runtime/state/workspaces";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useId, useState } from "react";
import { create } from "zustand";

import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { newProjectId } from "../lib/utils";
import { useProjects, waitForProject } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { MiddleTruncate } from "./ui/middle-truncate";
import { stackedThreadToast, toastManager } from "./ui/toast";

const useRequest = create<{ environmentId: EnvironmentId | null; session: number }>(() => ({
  environmentId: null,
  session: 0,
}));

/** Opens the dialog that makes a workspace from projects on `environmentId`. */
export function openNewWorkspace(environmentId: EnvironmentId) {
  useRequest.setState((state) => ({ environmentId, session: state.session + 1 }));
}

function close() {
  useRequest.setState({ environmentId: null });
}

export function NewWorkspaceDialogHost() {
  const environmentId = useRequest((state) => state.environmentId);
  const session = useRequest((state) => state.session);
  return environmentId ? <NewWorkspaceDialog key={session} environmentId={environmentId} /> : null;
}

interface SelectedRepository {
  readonly projectId: ProjectId;
  readonly name: string;
}

function NewWorkspaceDialog({ environmentId }: { environmentId: EnvironmentId }) {
  const id = useId();
  const candidates = workspaceRepositoryCandidates(useProjects(), environmentId);
  const canCreate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const handleNewThread = useNewThreadHandler();
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<ReadonlyArray<SelectedRepository>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A project can leave the store while the dialog is open; it then stops counting.
  const repositories = selected.flatMap((repository) => {
    const project = candidates.find((candidate) => candidate.id === repository.projectId);
    return project ? [{ ...repository, title: project.title }] : [];
  });
  const problem = workspaceRepositoriesProblem(repositories);

  const toggle = (
    project: { readonly id: ProjectId; readonly title: string; readonly workspaceRoot: string },
    checked: boolean,
  ) => {
    setError(null);
    setSelected((current) =>
      checked
        ? [...current, { projectId: project.id, name: defaultWorkspaceRepositoryName(project) }]
        : current.filter((repository) => repository.projectId !== project.id),
    );
  };
  const rename = (projectId: ProjectId, name: string) => {
    setError(null);
    setSelected((current) =>
      current.map((repository) =>
        repository.projectId === projectId ? { ...repository, name } : repository,
      ),
    );
  };

  const submit = async () => {
    if (submitting || problem !== null) return;
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) {
      setError("Name the workspace.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const projectId = newProjectId();
    const result = await createProject({
      environmentId,
      input: {
        projectId,
        title: trimmedTitle,
        roots: repositories.map((repository) => ({
          projectId: repository.projectId,
          name: repository.name.trim(),
        })),
      },
    });
    if (result._tag === "Failure") {
      setSubmitting(false);
      if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Could not create the workspace.");
      }
      return;
    }
    close();
    const projectRef = scopeProjectRef(environmentId, projectId);
    try {
      // Drafts key off the stored project, so the new thread waits for it to arrive.
      await waitForProject(projectRef);
      await handleNewThread(projectRef);
    } catch (cause) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to open workspace",
          description: `${cause instanceof Error ? cause.message : "An error occurred."} It will appear in the sidebar once this client catches up.`,
        }),
      );
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New workspace</DialogTitle>
            <DialogDescription>
              Work across {MIN_WORKSPACE_REPOSITORIES} to {MAX_WORKSPACE_REPOSITORIES} repositories
              in one thread. Each thread gets a new worktree of every repository, side by side in
              one folder.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-title`}>Name</Label>
              <Input
                id={`${id}-title`}
                value={title}
                onChange={(event) => {
                  setError(null);
                  setTitle(event.target.value);
                }}
                autoComplete="off"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Repositories</Label>
              {candidates.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  Add the repositories as projects first.
                </p>
              ) : (
                <div className="max-h-80 overflow-y-auto rounded-lg border">
                  {candidates.map((project) => {
                    const repository = selected.find(
                      (candidate) => candidate.projectId === project.id,
                    );
                    return (
                      <div
                        key={project.id}
                        className="flex flex-col gap-1.5 px-2.5 py-2 not-last:border-b"
                      >
                        <label className="flex cursor-pointer items-center gap-2 text-sm">
                          <Checkbox
                            checked={repository !== undefined}
                            onCheckedChange={(checked) => toggle(project, checked)}
                          />
                          <span className="min-w-0 shrink-0 truncate font-medium">
                            {project.title}
                          </span>
                          <span className="flex min-w-0 flex-1 font-mono text-muted-foreground text-xs">
                            <MiddleTruncate value={project.workspaceRoot} />
                          </span>
                        </label>
                        {repository ? (
                          <div className="flex items-center gap-2 ps-6">
                            <Label htmlFor={`${id}-${project.id}`} className="shrink-0">
                              Folder name
                            </Label>
                            <Input
                              id={`${id}-${project.id}`}
                              size="sm"
                              value={repository.name}
                              onChange={(event) => rename(project.id, event.target.value)}
                              spellCheck={false}
                              autoComplete="off"
                            />
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
              {selected.length > 0 && problem !== null ? (
                <p className="text-muted-foreground text-xs">{problem}</p>
              ) : null}
            </div>

            {error ? <p className="text-destructive-foreground text-sm">{error}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canCreate || submitting || problem !== null}>
              {submitting ? "Creating…" : "Create workspace"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
