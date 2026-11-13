import { isWorkspaceProject } from "@t3tools/client-runtime/state/workspaces";
import { spacePullRequestLabel } from "@t3tools/client-runtime/spaces";
import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationV2ThreadShell,
  ProjectId,
  Space,
  SpaceTask,
  SpaceTaskBase,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BoxesIcon, FolderCodeIcon } from "lucide-react";
import { RegistryContext } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { useContext, useRef, useState } from "react";

import { spaceEnvironment, useSpaceProjects } from "../../state/spaces";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { Label } from "../ui/label";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Textarea } from "../ui/textarea";
import { SpaceModelPicker, useSpaceModelSelection } from "./SpaceModelPicker";

const BASE_BRANCH = "base";

/** "Start a thread on <task>": where it runs, the model, the base and the first message. */
export function SpaceStartThreadDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly task: SpaceTask;
  /** The task's threads, whose open pull requests can be continued. */
  readonly threads: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "projectId" | "pullRequests">>;
  readonly onClose: () => void;
}) {
  const { space, task } = props;
  const registry = useContext(RegistryContext);
  const navigate = useNavigate();
  const projects = useSpaceProjects(props.environmentId);
  const [projectId, setProjectId] = useState<ProjectId>(space.projectId);
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const [baseRef, setBaseRef] = useState("");
  const [from, setFrom] = useState(BASE_BRANCH);
  const [text, setText] = useState(task.description);
  const [busy, setBusy] = useState(false);
  // Cancel start interrupts the RPC; the server then deletes the thread and links nothing.
  const pending = useRef<AbortController | null>(null);
  const model = useSpaceModelSelection(props.environmentId, projectId, picked).selection;

  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const workspaces = projects.filter((candidate) => isWorkspaceProject(candidate));
  const repositories = projects.filter((candidate) => !isWorkspaceProject(candidate));
  const spaceDefault = projects.find((candidate) => candidate.id === space.projectId) ?? null;
  const singleRepo = project !== null && !isWorkspaceProject(project);
  const pullRequests = singleRepo
    ? props.threads
        .filter((thread) => thread.projectId === projectId)
        .flatMap((thread) => thread.pullRequests ?? [])
        .filter((link) => link.snapshot?.state === "open")
    : [];
  const continued = pullRequests.find((link) => `${link.number}` === from) ?? null;
  const body = text.trim();
  const ready = !busy && model !== null && body !== "";
  const baseLabel = baseRef.trim() === "" ? "Default branch" : `Base branch ${baseRef.trim()}`;

  // No baseRef starts from the repository's default branch, as a workspace always does.
  const base = (): SpaceTaskBase =>
    continued?.snapshot == null
      ? baseRef.trim() === "" || !singleRepo
        ? {}
        : { baseRef: baseRef.trim() }
      : {
          baseRef: continued.snapshot.baseBranch,
          branch: continued.snapshot.headBranch,
          existingBranch: true,
          pullRequest: { number: continued.number, url: continued.url },
        };

  const start = async () => {
    if (!ready || model === null) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    const result = await runAtomCommand(
      registry,
      spaceEnvironment.startThread,
      {
        environmentId: props.environmentId,
        input: {
          spaceId: space.id,
          taskId: task.id,
          projectId,
          modelSelection: model,
          base: base(),
          ...(body === task.description ? {} : { text: body }),
        },
      },
      { label: "Start a thread", signal: controller.signal },
    );
    if (controller.signal.aborted) return;
    pending.current = null;
    setBusy(false);
    toastCommandFailure("Could not start the thread", result);
    if (result._tag !== "Success") return;
    props.onClose();
    const threadId = result.value.threadId;
    if (threadId !== undefined) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: props.environmentId, threadId },
      });
    }
  };

  const cancel = () => {
    pending.current?.abort();
    pending.current = null;
    props.onClose();
  };

  const projectLabel = (candidate: (typeof projects)[number]) => (
    <span className="flex min-w-0 items-center gap-1.5">
      {isWorkspaceProject(candidate) ? (
        <BoxesIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <FolderCodeIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="truncate">{candidate.title}</span>
      {isWorkspaceProject(candidate) ? (
        <span className="truncate text-muted-foreground text-xs">
          {candidate.roots.map((root) => root.name).join(", ")}
        </span>
      ) : null}
      {candidate.id === space.projectId ? (
        <span className="shrink-0 text-muted-foreground text-xs">Space default</span>
      ) : null}
    </span>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && cancel()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Start a thread on {task.title}</DialogTitle>
          <DialogDescription>It runs on your account.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div
            className="flex flex-col gap-4"
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
              if (event.nativeEvent.isComposing) return;
              event.preventDefault();
              void start();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <Label htmlFor="space-start-prompt">Prompt</Label>
                <span className="text-muted-foreground text-xs">From the task · edit freely</span>
              </div>
              <Textarea
                id="space-start-prompt"
                autoFocus
                value={text}
                disabled={busy}
                onChange={(event) => setText(event.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                The thread also reads the brief, Pair's notes and the task's other threads.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Runs in</Label>
              <Select
                value={projectId}
                disabled={busy}
                onValueChange={(value) => {
                  setProjectId(value as ProjectId);
                  setFrom(BASE_BRANCH);
                }}
              >
                <SelectTrigger size="sm" aria-label="Runs in">
                  <SelectValue>{project === null ? "Choose" : projectLabel(project)}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {spaceDefault === null ? null : (
                    <SelectItem value={spaceDefault.id}>{projectLabel(spaceDefault)}</SelectItem>
                  )}
                  {workspaces.length === 0 ? null : (
                    <SelectGroup>
                      <SelectGroupLabel>Workspaces</SelectGroupLabel>
                      {workspaces
                        .filter((candidate) => candidate.id !== space.projectId)
                        .map((candidate) => (
                          <SelectItem key={candidate.id} value={candidate.id}>
                            {projectLabel(candidate)}
                          </SelectItem>
                        ))}
                    </SelectGroup>
                  )}
                  <SelectGroup>
                    <SelectGroupLabel>Projects</SelectGroupLabel>
                    {repositories
                      .filter((candidate) => candidate.id !== space.projectId)
                      .map((candidate) => (
                        <SelectItem key={candidate.id} value={candidate.id}>
                          {projectLabel(candidate)}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                </SelectPopup>
              </Select>
              {project !== null && isWorkspaceProject(project) ? (
                <p className="text-muted-foreground text-xs">
                  A thread checks out every repository in its workspace.
                </p>
              ) : null}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label>Model</Label>
                <SpaceModelPicker
                  environmentId={props.environmentId}
                  projectId={projectId}
                  value={picked}
                  disabled={busy}
                  onChange={setPicked}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Start from</Label>
                {pullRequests.length === 0 ? (
                  <Input
                    aria-label="Base branch"
                    value={baseRef}
                    placeholder="Default branch"
                    disabled={busy || !singleRepo}
                    onChange={(event) => setBaseRef(event.target.value)}
                  />
                ) : (
                  <Select
                    value={from}
                    disabled={busy}
                    onValueChange={(value) => setFrom(value as string)}
                  >
                    <SelectTrigger size="sm" aria-label="Start from">
                      <SelectValue>
                        {continued === null
                          ? baseLabel
                          : `Continue ${spacePullRequestLabel(continued)}`}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value={BASE_BRANCH}>{baseLabel}</SelectItem>
                      <SelectGroup>
                        <SelectGroupLabel>Continue a pull request</SelectGroupLabel>
                        {pullRequests.map((link) => (
                          <SelectItem
                            key={`${link.repository}#${link.number}`}
                            value={`${link.number}`}
                          >
                            {spacePullRequestLabel(link)}
                            {link.snapshot === null ? null : (
                              <span className="truncate text-muted-foreground">
                                {link.snapshot.title}
                              </span>
                            )}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectPopup>
                  </Select>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Account</span>
              {model === null ? (
                <>
                  <span className="flex-1">Not connected</span>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      cancel();
                      void navigate({ to: "/settings/providers" });
                    }}
                  >
                    Connect Claude
                  </Button>
                </>
              ) : (
                <span className="flex-1">Runs on your account</span>
              )}
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <span className="me-auto self-center text-muted-foreground text-xs">
            Linked to the task. Space members can see it.
          </span>
          <Button size="sm" variant="ghost" onClick={cancel}>
            {busy ? "Cancel start" : "Cancel"}
          </Button>
          <Button size="sm" disabled={!ready} onClick={() => void start()}>
            {busy ? "Starting…" : "Start"}
            <Kbd>⌘↵</Kbd>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
