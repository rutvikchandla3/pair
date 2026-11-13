import {
  type SpaceViewer,
  groupSpaceOverview,
  spaceAttachConfirmCopy,
  spaceControls,
  spaceThreadRunsIn,
  spaceThreadsByTask,
  spaceTaskStatusInfo,
} from "@t3tools/client-runtime/spaces";
import type {
  EnvironmentId,
  Space,
  SpaceId,
  SpaceTask,
  SpaceTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { ChevronLeftIcon, PlusIcon, UsersIcon } from "lucide-react";
import { useState } from "react";

import { useThreadShells } from "../../state/entities";
import {
  spaceEnvironment,
  useCanOperateSpaces,
  useSpaceListResult,
  useSpaceProjects,
  useSpaceTaskThreads,
  useSpaceViewer,
} from "../../state/spaces";
import { useTeamMembers } from "../../state/team";
import { useAtomCommand } from "../../state/use-atom-command";
import { MemberAvatar } from "../team/MemberAvatar";
import { MemberAvatarStack } from "../team/MemberAvatarStack";
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
import { toastManager } from "../ui/toast";
import { SpaceTaskStatusGlyph } from "./SpaceStatusIcon";
import type { SpaceThreadDialogRequest } from "./spaceThreadDialogStore";

type Target = { readonly spaceId: SpaceId; readonly taskId: SpaceTaskId };

const ROW =
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-accent";

/** Add a thread to a task: thread (from a task page) → space → task → "Add and share". */
export function SpaceAttachThreadDialog(props: {
  readonly request: Extract<SpaceThreadDialogRequest, { type: "attach" }>;
  readonly onClose: () => void;
}) {
  const { environmentId } = props.request;
  const viewer = useSpaceViewer(environmentId);
  const canOperate = useCanOperateSpaces(environmentId);
  const list = useSpaceListResult(environmentId);
  const shells = useThreadShells();
  const projects = useSpaceProjects(environmentId);
  const linkThread = useAtomCommand(spaceEnvironment.linkThread, "Add thread to task");
  const [threadId, setThreadId] = useState<ThreadId | null>(props.request.threadId);
  const [spaceId, setSpaceId] = useState<SpaceId | null>(props.request.target?.spaceId ?? null);
  const [target, setTarget] = useState<Target | null>(props.request.target);
  const [busy, setBusy] = useState(false);
  const moving = props.request.fromTaskId !== undefined;

  const mine = shells.filter(
    (shell) =>
      shell.environmentId === environmentId &&
      shell.archivedAt === null &&
      shell.source.space === undefined &&
      viewer.memberId !== null &&
      shell.source.ownerId === viewer.memberId,
  );
  const thread = shells.find(
    (shell) => shell.environmentId === environmentId && shell.id === threadId,
  );
  const spaces = list.spaces.filter(
    (space) => spaceControls(space, viewer.memberId, canOperate).canCreateTask,
  );
  const space = list.spaces.find((candidate) => candidate.id === spaceId) ?? null;
  const task = target === null ? null : (list.tasks.find((t) => t.id === target.taskId) ?? null);

  const confirm = async () => {
    if (threadId === null || target === null) return;
    setBusy(true);
    const result = await linkThread({ environmentId, input: { threadId, target } });
    setBusy(false);
    toastCommandFailure(moving ? "Could not move the thread" : "Could not add the thread", result);
    if (result._tag !== "Success") return;
    props.onClose();
    toastManager.add({
      type: "success",
      title: `${moving ? "Moved to" : "Added to"} ${result.value.task?.title ?? "the task"}`,
    });
  };

  const back = () => {
    if (target !== null && props.request.target === null) setTarget(null);
    else if (spaceId !== null && props.request.target === null) setSpaceId(null);
    else if (props.request.threadId === null) setThreadId(null);
  };
  const canGoBack =
    (target !== null && props.request.target === null) ||
    (spaceId !== null && props.request.target === null) ||
    (threadId !== null && props.request.threadId === null);

  const step =
    threadId === null ? "thread" : space === null ? "space" : target === null ? "task" : "confirm";
  const title =
    step === "confirm" && task !== null
      ? `${moving ? "Move to" : "Add to"} ${task.title}`
      : step === "thread"
        ? "Add existing thread"
        : moving
          ? "Move to another task"
          : "Add to task";

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            <span className="flex items-center gap-1">
              {canGoBack ? (
                <Button size="icon-xs" variant="ghost-muted" aria-label="Back" onClick={back}>
                  <ChevronLeftIcon />
                </Button>
              ) : null}
              {title}
            </span>
          </DialogTitle>
          {step === "space" ? (
            <DialogDescription>
              Only spaces you're a member of. The space's members will see the thread.
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <DialogPanel>
          {step === "thread" ? (
            <div className="flex flex-col gap-0.5">
              {mine.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  None of your threads here are free to add.
                </p>
              ) : (
                mine.map((shell) => (
                  <button
                    key={shell.id}
                    type="button"
                    className={ROW}
                    onClick={() => setThreadId(shell.id)}
                  >
                    <span className="min-w-0 flex-1 truncate">{shell.title}</span>
                    <span className="shrink-0 text-muted-foreground text-xs">
                      {spaceThreadRunsIn(shell, projects) ?? ""}
                    </span>
                  </button>
                ))
              )}
            </div>
          ) : step === "space" ? (
            <div className="flex flex-col gap-0.5">
              <p className="px-2 pb-1 font-medium text-muted-foreground text-xs">Your spaces</p>
              {spaces.map((candidate) => {
                const members = candidate.members.filter((m) => m.removedAt === null).length;
                const tasks = list.tasks.filter(
                  (t) => t.spaceId === candidate.id && t.deletedAt === null,
                ).length;
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    className={ROW}
                    onClick={() => setSpaceId(candidate.id)}
                  >
                    <UsersIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
                    <span className="shrink-0 text-muted-foreground text-xs">
                      {members} members · {tasks} tasks
                    </span>
                  </button>
                );
              })}
            </div>
          ) : step === "task" && space !== null ? (
            <TaskPicker
              environmentId={environmentId}
              space={space}
              tasks={list.tasks.filter(
                (t) => t.spaceId === space.id && t.id !== props.request.fromTaskId,
              )}
              viewer={viewer}
              onPick={(taskId) => setTarget({ spaceId: space.id, taskId })}
            />
          ) : space !== null && task !== null ? (
            <AttachConfirm
              environmentId={environmentId}
              space={space}
              task={task}
              viewer={viewer}
              runsIn={thread === undefined ? null : spaceThreadRunsIn(thread, projects)}
            />
          ) : null}
        </DialogPanel>
        {step === "confirm" ? (
          <DialogFooter>
            <Button size="sm" variant="ghost" disabled={busy} onClick={props.onClose}>
              Cancel
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void confirm()}>
              {moving ? "Move" : "Add and share"}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function TaskPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly tasks: ReadonlyArray<SpaceTask>;
  readonly viewer: SpaceViewer;
  readonly onPick: (taskId: SpaceTaskId) => void;
}) {
  const threads = useSpaceTaskThreads(props.environmentId, props.space.id, []);
  const roster = useTeamMembers(props.environmentId);
  const createTask = useAtomCommand(spaceEnvironment.task, "Create task");
  const [title, setTitle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const threadsByTask = spaceThreadsByTask(threads);
  const sections = groupSpaceOverview(
    props.tasks.filter((task) => task.deletedAt === null),
    threadsByTask,
    props.viewer,
  );

  const create = async () => {
    const name = title?.trim() ?? "";
    if (name === "" || props.viewer.memberId === null) return;
    setBusy(true);
    const result = await createTask({
      environmentId: props.environmentId,
      input: {
        type: "create",
        spaceId: props.space.id,
        title: name,
        description: name,
        ownerId: props.viewer.memberId,
      },
    });
    setBusy(false);
    toastCommandFailure("Could not create the task", result);
    if (result._tag === "Success" && result.value.task !== null) props.onPick(result.value.task.id);
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="px-2 font-medium text-sm">{props.space.name}</p>
      {sections.map((section) => (
        <div key={section.id} className="flex flex-col gap-0.5">
          <p className="px-2 text-muted-foreground text-xs">
            {section.label} {section.rows.length}
          </p>
          {section.rows.map((row) => {
            const status = spaceTaskStatusInfo(row.task.status);
            const owner = props.viewer.nameOf(row.task.ownerId);
            return (
              <button
                key={row.task.id}
                type="button"
                className={ROW}
                onClick={() => props.onPick(row.task.id)}
              >
                <SpaceTaskStatusGlyph icon={status.icon} tone={status.tone} label={status.label} />
                <span className="min-w-0 flex-1 truncate">{row.task.title}</span>
                <MemberAvatar
                  size="sm"
                  member={{
                    name: owner,
                    color: roster.get(row.task.ownerId)?.color ?? "var(--muted-foreground)",
                  }}
                />
                <span className="shrink-0 text-muted-foreground text-xs">
                  {row.threads.length === 0
                    ? "No threads"
                    : `${row.threads.length} ${row.threads.length === 1 ? "thread" : "threads"}`}
                </span>
              </button>
            );
          })}
        </div>
      ))}
      {title === null ? (
        <button type="button" className={ROW} onClick={() => setTitle("")}>
          <PlusIcon aria-hidden className="size-3.5 text-muted-foreground" />
          New task in {props.space.name}
        </button>
      ) : (
        <div className="flex items-center gap-2 px-2">
          <Input
            autoFocus
            aria-label="Task title"
            placeholder="Task title"
            value={title}
            disabled={busy}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void create();
            }}
          />
          <Button size="sm" disabled={busy || title.trim() === ""} onClick={() => void create()}>
            Create
          </Button>
        </div>
      )}
    </div>
  );
}

/** Who will see the thread once it's on the task, from `spaceAttachConfirmCopy`. */
export function AttachConfirm(props: {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly task: SpaceTask;
  readonly viewer: SpaceViewer;
  readonly runsIn: string | null;
}) {
  const roster = useTeamMembers(props.environmentId);
  const status = spaceTaskStatusInfo(props.task.status);
  const copy = spaceAttachConfirmCopy(props.space, props.viewer, props.runsIn);
  const others = props.space.members
    .filter((member) => member.removedAt === null && member.memberId !== props.viewer.memberId)
    .map((member) => ({
      id: member.memberId,
      name: props.viewer.nameOf(member.memberId),
      color: roster.get(member.memberId)?.color ?? "var(--muted-foreground)",
      away: false,
    }));
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <SpaceTaskStatusGlyph icon={status.icon} tone={status.tone} />
        {status.label} · {props.viewer.nameOf(props.task.ownerId)}
      </p>
      <div className="flex items-start gap-2">
        {others.length === 0 ? null : <MemberAvatarStack members={others} />}
        <p>{copy.description}</p>
      </div>
    </div>
  );
}
