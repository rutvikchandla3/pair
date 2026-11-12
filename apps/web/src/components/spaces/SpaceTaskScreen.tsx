import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isWorkspaceProject } from "@t3tools/client-runtime/state/workspaces";
import { orderSpaceMembers, spaceTaskControls } from "@t3tools/client-runtime/spaces";
import type {
  EnvironmentId,
  MemberId,
  ModelSelection,
  OrchestrationV2ThreadShell,
  ScopedThreadRef,
  Space,
  SpaceTaskAction,
  ThreadId,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ClockIcon,
  CloudIcon,
  FileTextIcon,
  LayoutListIcon,
  PlayIcon,
  UserRoundIcon,
  UsersRoundIcon,
} from "lucide-react";
import * as DateTime from "effect/DateTime";
import { useState } from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { openSpaceDialog } from "../../spaceDialogStore";
import { useProject, useThreadShell } from "../../state/entities";
import {
  spaceEnvironment,
  useCanOperateSpaces,
  useSpaceList,
  useSpaceTasks,
  useSpaceViewer,
} from "../../state/spaces";
import { useTeamMembers } from "../../state/team";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { MemberAvatar } from "../team/MemberAvatar";
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
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Textarea } from "../ui/textarea";
import {
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { SpaceModelPicker, useSpaceModelSelection } from "./SpaceModelPicker";
import { SpaceOverview } from "./SpaceRoomPanel";

interface SpaceTaskContext {
  readonly thread: OrchestrationV2ThreadShell;
  readonly space: Space;
}

/** The task's raw shell and its space, or null for any other thread. */
function useSpaceTask(environmentId: EnvironmentId | null, threadId: ThreadId | null) {
  const shell = useThreadShell(
    environmentId === null || threadId === null ? null : scopeThreadRef(environmentId, threadId),
  );
  const spaces = useSpaceList(shell?.source.space?.kind === "task" ? environmentId : null);
  const placement = shell?.source.space;
  if (shell === null || placement?.kind !== "task") return null;
  const space = spaces.find((candidate) => candidate.id === placement.spaceId);
  return space === undefined ? null : ({ thread: shell.source, space } satisfies SpaceTaskContext);
}

/** For the composer: whose model and Stop this is when the viewer isn't the task's owner. */
export function useSpaceTaskComposerLock(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
) {
  const task = useSpaceTask(environmentId, threadId);
  const viewer = useSpaceViewer(environmentId);
  const canOperate = useCanOperateSpaces(environmentId);
  if (task === null) return null;
  const controls = spaceTaskControls(task.thread, task.space, viewer.memberId, canOperate);
  if (!controls.modelLocked) return null;
  const ownerName = task.thread.ownerId == null ? "the owner" : viewer.nameOf(task.thread.ownerId);
  return { ownerName, stopNeedsConfirm: controls.stopNeedsConfirm };
}

export function SpaceTaskCrumb(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const task = useSpaceTask(props.environmentId, props.threadId);
  if (task === null) return null;
  return (
    <>
      <WorkspaceBreadcrumbItem className="shrink">
        <Link
          to="/spaces/$environmentId/$spaceId"
          params={{ environmentId: props.environmentId, spaceId: task.space.id }}
          className="truncate rounded-sm text-muted-foreground hover:text-foreground"
        >
          {task.space.name}
        </Link>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          aria-label="Space overview"
          onClick={() =>
            useRightPanelStore
              .getState()
              .open(scopeThreadRef(props.environmentId, props.threadId), "space-overview")
          }
        >
          <LayoutListIcon />
        </Button>
      </WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator>
        <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
      </WorkspaceBreadcrumbSeparator>
    </>
  );
}

/** The space's Overview as a tab of the task's own right panel. */
export function SpaceTaskOverviewPanel(props: { readonly threadRef: ScopedThreadRef }) {
  const task = useSpaceTask(props.threadRef.environmentId, props.threadRef.threadId);
  const viewer = useSpaceViewer(props.threadRef.environmentId);
  const canOperate = useCanOperateSpaces(props.threadRef.environmentId);
  const tasks = useSpaceTasks(
    props.threadRef.environmentId,
    task?.space.id ?? ("" as Space["id"]),
    [],
  );
  if (task === null) {
    return <p className="p-4 text-muted-foreground text-sm">This thread isn't in a space.</p>;
  }
  const writable = canOperate && task.space.archivedAt === null && viewer.memberId !== null;
  return (
    <div className="h-full overflow-y-auto">
      <SpaceOverview
        environmentId={props.threadRef.environmentId}
        space={task.space}
        tasks={tasks}
        viewer={viewer}
        canCreateTask={writable}
        onNewTask={() =>
          openSpaceDialog({
            type: "new-task",
            environmentId: props.threadRef.environmentId,
            spaceId: task.space.id,
          })
        }
      />
    </div>
  );
}

type TaskDialog = "hand-back" | "edit" | null;

/** An unstarted space task, with the viewer's part in it; null once it starts or off a space. */
export function useUnstartedSpaceTask(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
) {
  const task = useSpaceTask(environmentId, threadId);
  const viewer = useSpaceViewer(environmentId);
  const canOperate = useCanOperateSpaces(environmentId);
  if (task === null || task.thread.space?.kind !== "task") return null;
  const controls = spaceTaskControls(task.thread, task.space, viewer.memberId, canOperate);
  if (controls.started) return null;
  return { ...task, placement: task.thread.space, controls, viewer };
}

type UnstartedSpaceTask = NonNullable<ReturnType<typeof useUnstartedSpaceTask>>;

const assignedAtFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});
const postedAtFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
// Today reads as a bare time, as in the room feed.
const formatAssignedAt = (millis: number) =>
  (new Date(millis).toDateString() === new Date().toDateString()
    ? postedAtFormat
    : assignedAtFormat
  ).format(millis);

function ownerNameOf(task: UnstartedSpaceTask) {
  return task.thread.ownerId == null ? "its owner" : task.viewer.nameOf(task.thread.ownerId);
}

function useTaskActions(environmentId: EnvironmentId, task: UnstartedSpaceTask | null) {
  const run = useAtomCommand(spaceEnvironment.task, "Update task");
  const [busy, setBusy] = useState(false);
  const act = async (action: SpaceTaskAction, failure: string) => {
    if (busy) return false;
    setBusy(true);
    const result = await run({ environmentId, input: action });
    setBusy(false);
    toastCommandFailure(failure, result);
    return result._tag === "Success";
  };
  const others =
    task === null
      ? []
      : orderSpaceMembers(task.space).filter((member) => member.memberId !== task.thread.ownerId);
  return { busy, act, others };
}

function AssignMenu(props: {
  readonly label: string;
  readonly variant: "outline" | "ghost";
  readonly task: UnstartedSpaceTask;
  readonly members: ReadonlyArray<{ readonly memberId: MemberId }>;
  readonly disabled: boolean;
  readonly onPick: (ownerId: MemberId) => void;
}) {
  if (props.members.length === 0) return null;
  return (
    <Menu>
      <MenuTrigger render={<Button size="sm" variant={props.variant} disabled={props.disabled} />}>
        {props.label}
      </MenuTrigger>
      <MenuPopup align="end">
        {props.members.map((member) => (
          <MenuItem key={member.memberId} onClick={() => props.onPick(member.memberId)}>
            {member.memberId === props.task.viewer.memberId
              ? "You"
              : props.task.viewer.nameOf(member.memberId)}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

/** The top of an unstarted task's timeline: who assigned it where, then the unsent description. */
export function SpaceTaskIntro(props: {
  readonly environmentId: EnvironmentId;
  readonly task: UnstartedSpaceTask;
}) {
  const { task } = props;
  const members = useTeamMembers(props.environmentId);
  const { act } = useTaskActions(props.environmentId, task);
  const [editing, setEditing] = useState(false);
  const { viewer, placement } = task;
  const ownerName = ownerNameOf(task);
  const isOwner = task.controls.isTaskOwner;
  const assigner =
    placement.createdBy === viewer.memberId ? "You" : viewer.nameOf(placement.createdBy);
  const assignee = isOwner ? "you" : ownerName;
  const creator = members.get(placement.createdBy);
  return (
    <div className="chat-content-lane flex flex-col gap-4 pt-4 pb-6">
      <p className="flex flex-wrap items-center justify-center gap-1 text-muted-foreground text-xs">
        <UserRoundIcon className="size-3.5" />
        <span>
          {assigner} assigned this to {assignee} in
        </span>
        <Link
          to="/spaces/$environmentId/$spaceId"
          params={{ environmentId: props.environmentId, spaceId: task.space.id }}
          className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
        >
          <UsersRoundIcon className="size-3.5" />
          {task.space.name}
        </Link>
        <span>· {formatAssignedAt(DateTime.toEpochMillis(task.thread.createdAt))}</span>
      </p>
      {isOwner ? null : (
        <div className="flex flex-col items-end gap-1.5 ps-12">
          <div className="flex items-center gap-1.5">
            <MemberAvatar
              size="sm"
              member={{
                name: viewer.nameOf(placement.createdBy),
                color: creator?.color ?? "var(--muted-foreground)",
              }}
            />
            <span className="font-medium text-sm">{viewer.nameOf(placement.createdBy)}</span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {postedAtFormat.format(DateTime.toEpochMillis(task.thread.createdAt))}
            </span>
          </div>
          <p className="whitespace-pre-wrap break-words rounded-xl border border-input border-dashed px-3 py-2 text-sm">
            {placement.description}
          </p>
          <p className="flex items-center gap-1 text-muted-foreground text-xs">
            <ClockIcon className="size-3.5" />
            Not sent yet · sends when {ownerName} starts the task
            {task.controls.canNudge ? (
              <>
                {" · "}
                <Button size="micro" variant="ghost-muted" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              </>
            ) : null}
          </p>
        </div>
      )}
      {editing ? (
        <EditTaskDialog
          title={task.thread.title}
          description={placement.description}
          onClose={() => setEditing(false)}
          onSubmit={(title, description) =>
            act({ type: "edit", threadId: task.thread.id, title, description }, "Could not save")
          }
        />
      ) : null}
    </div>
  );
}

/** In place of the composer until the task starts: the owner's start, or who it waits for. */
export function SpaceTaskStartBar(props: {
  readonly environmentId: EnvironmentId;
  readonly task: UnstartedSpaceTask;
}) {
  const { task } = props;
  const { busy, act, others } = useTaskActions(props.environmentId, task);
  if (task.controls.canStart) {
    return <SpaceTaskStartComposer environmentId={props.environmentId} task={task} />;
  }
  const ownerName = ownerNameOf(task);
  const creatorName = task.viewer.nameOf(task.placement.createdBy);
  const reassign = (ownerId: MemberId) =>
    void act({ type: "reassign", threadId: task.thread.id, ownerId }, "Could not reassign");
  return (
    <div className="flex min-h-12 flex-wrap items-center gap-2 rounded-2xl border border-border bg-card px-3 py-2 text-sm">
      <ClockIcon className="size-4 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">Waiting for {ownerName} to start</span>
        <span className="text-muted-foreground">
          {" "}
          · assigned {formatRelativeTimeLabel(DateTime.formatIso(task.thread.createdAt))}
        </span>
      </span>
      {task.controls.canNudge ? (
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void act({ type: "remind", threadId: task.thread.id }, "Could not remind")
            }
          >
            Remind {ownerName}
          </Button>
          <AssignMenu
            label="Reassign"
            variant="outline"
            task={task}
            members={others}
            disabled={busy}
            onPick={reassign}
          />
        </>
      ) : (
        <span className="text-muted-foreground text-xs">
          {task.thread.ownerId === task.placement.createdBy
            ? `Only ${ownerName} can change this`
            : `Only ${ownerName} or ${creatorName} can change this`}
        </span>
      )}
    </div>
  );
}

function SpaceTaskStartComposer(props: {
  readonly environmentId: EnvironmentId;
  readonly task: UnstartedSpaceTask;
}) {
  const { task } = props;
  const navigate = useNavigate();
  const { busy, act, others } = useTaskActions(props.environmentId, task);
  const project = useProject(scopeProjectRef(props.environmentId, task.space.projectId));
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const [text, setText] = useState(task.placement.description);
  const [dialog, setDialog] = useState<TaskDialog>(null);
  const model = useSpaceModelSelection(props.environmentId, task.space.projectId, picked).selection;
  const { viewer, placement } = task;
  const ownTask = placement.createdBy === viewer.memberId;
  const body = text.trim();
  const canStart = !busy && model !== null && body !== "";
  const repos = isWorkspaceProject(project)
    ? project.roots.map((root) => root.name)
    : [project?.title ?? "the project"];

  const start = () => {
    if (!canStart) return;
    void act(
      {
        type: "start",
        threadId: task.thread.id,
        modelSelection: model,
        ...(body === placement.description ? {} : { text: body }),
      },
      "Could not start",
    );
  };
  const reassign = (ownerId: MemberId) =>
    void act({ type: "reassign", threadId: task.thread.id, ownerId }, "Could not reassign");

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-col rounded-2xl border border-border bg-card p-1.5 focus-within:border-ring">
        <div className="flex items-center gap-1.5 rounded-lg bg-muted/60 px-2.5 py-1.5 text-xs">
          <FileTextIcon className="size-3.5 text-muted-foreground" />
          <span className="font-medium">
            {ownTask ? "Your description" : `${viewer.nameOf(placement.createdBy)}'s description`}
          </span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            · edit it before you start
          </span>
          <span className="shrink-0 text-muted-foreground max-sm:hidden">
            Also reads brief and notes
          </span>
        </div>
        <textarea
          value={text}
          aria-label="Task description"
          className="field-sizing-content block max-h-64 min-h-16 w-full resize-none bg-transparent px-2 py-2.5 text-sm outline-none"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
            if (event.nativeEvent.isComposing) return;
            event.preventDefault();
            start();
          }}
        />
        {model === null ? (
          <div
            role="status"
            className="mx-1 mb-1.5 flex items-center gap-2 rounded-md bg-warning/10 px-3 py-2 text-sm text-warning-foreground"
          >
            <span className="min-w-0 flex-1">
              Connect a provider account in Settings to start this task. It runs on your account.
            </span>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void navigate({ to: "/settings/providers" })}
            >
              Open Settings
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-1">
          <SpaceModelPicker
            environmentId={props.environmentId}
            projectId={task.space.projectId}
            value={picked}
            disabled={busy}
            onChange={setPicked}
          />
          <span className="flex-1" />
          {ownTask ? null : (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setDialog("hand-back")}
            >
              Can't take it
            </Button>
          )}
          <AssignMenu
            label="Assign to…"
            variant="ghost"
            task={task}
            members={others}
            disabled={busy}
            onPick={reassign}
          />
          <Button size="sm" disabled={!canStart} onClick={start}>
            <PlayIcon />
            Start task
            <Kbd>⌘↵</Kbd>
          </Button>
        </div>
      </div>
      <p className="flex items-center gap-1.5 px-2 text-muted-foreground text-xs">
        <CloudIcon className="size-3.5" />
        Starts a cloud machine with {joinNames(repos)}. Nothing runs until then.
      </p>
      {dialog === "hand-back" ? (
        <HandBackDialog
          creatorName={viewer.nameOf(placement.createdBy)}
          onClose={() => setDialog(null)}
          onSubmit={(reason) =>
            act({ type: "hand-back", threadId: task.thread.id, reason }, "Could not hand it back")
          }
        />
      ) : null}
    </div>
  );
}

function joinNames(names: ReadonlyArray<string>) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function HandBackDialog(props: {
  readonly creatorName: string;
  readonly onClose: () => void;
  readonly onSubmit: (reason: string) => Promise<boolean>;
}) {
  const [reason, setReason] = useState("");
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Can't take it?</DialogTitle>
          <DialogDescription>
            It goes back to {props.creatorName}, with your reason in the room.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Textarea autoFocus value={reason} onChange={(event) => setReason(event.target.value)} />
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={reason.trim() === ""}
            onClick={() => void props.onSubmit(reason.trim()).then((ok) => ok && props.onClose())}
          >
            Hand back
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function EditTaskDialog(props: {
  readonly title: string;
  readonly description: string;
  readonly onClose: () => void;
  readonly onSubmit: (title: string, description: string) => Promise<boolean>;
}) {
  const [title, setTitle] = useState(props.title);
  const [description, setDescription] = useState(props.description);
  const ready = title.trim() !== "" && description.trim() !== "";
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Edit task</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <Input
              aria-label="Title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <Textarea
              aria-label="What to do"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!ready}
            onClick={() =>
              void props
                .onSubmit(title.trim(), description.trim())
                .then((ok) => ok && props.onClose())
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
