import {
  type SpaceControls,
  type SpaceRecordContext,
  type SpaceViewer,
  isSpaceTaskLineEntry,
  mergeSpaceThreads,
  orderSpaceMembers,
  spaceLiveTask,
  spaceMergedSuggestion,
  spacePullRequestLabel,
  spaceTaskAssignedAt,
  spaceTaskAssignmentNotice,
  spaceTaskControls,
  spaceTaskEntries,
  spaceTaskStatusInfo,
  spaceThreadActivityView,
  spaceThreadControls,
  spaceThreadRunsIn,
  spaceUndoneEntryIds,
} from "@t3tools/client-runtime/spaces";
import type {
  EnvironmentId,
  MemberId,
  OrchestrationV2ThreadShell,
  Space,
  SpaceRoomEntry,
  SpaceTask,
  SpaceTaskAction,
  SpaceTaskId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  CircleXIcon,
  EllipsisIcon,
  LinkIcon,
  PanelRightOpenIcon,
  PencilIcon,
  PlusIcon,
  UserRoundIcon,
} from "lucide-react";
import * as DateTime from "effect/DateTime";
import { useState } from "react";

import { isElectron } from "../../env";
import { spaceEnvironment, useSpaceProjects, useSpaceTaskView } from "../../state/spaces";
import { useTeamMembers } from "../../state/team";
import { useAtomCommand } from "../../state/use-atom-command";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { RelativeTime } from "../RelativeTime";
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
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SpaceRecordLine, SpaceSystemLine } from "./SpaceRecord";
import { SpaceActivityIcon, SpaceTaskStatusGlyph } from "./SpaceStatusIcon";
import { SpaceStatusMenu, useSetSpaceTaskStatus } from "./SpaceStatusMenu";
import { openSpaceThreadDialog } from "./spaceThreadDialogStore";

const EMPTY_THREADS: ReadonlyArray<OrchestrationV2ThreadShell> = [];

function spaceTaskUrl(environmentId: EnvironmentId, task: Pick<SpaceTask, "id" | "spaceId">) {
  return `${window.location.origin}/spaces/${environmentId}/${task.spaceId}/tasks/${task.id}`;
}

async function copySpaceTaskLink(
  environmentId: EnvironmentId,
  task: Pick<SpaceTask, "id" | "spaceId">,
) {
  try {
    await navigator.clipboard.writeText(spaceTaskUrl(environmentId, task));
    toastManager.add({ type: "success", title: "Link copied" });
  } catch {
    toastManager.add({ type: "error", title: "Could not copy the link" });
  }
}

/** The task page in the room's main column: properties, threads and activity. */
export function SpaceTaskPage(props: {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly taskId: SpaceTaskId;
  readonly roomTask: SpaceTask | null;
  readonly roomEntries: ReadonlyArray<SpaceRoomEntry>;
  readonly roomThreads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly viewer: SpaceViewer;
  readonly controls: SpaceControls;
  readonly panelHidden: boolean;
  readonly onShowPanel: () => void;
}) {
  const view = useSpaceTaskView(props.environmentId, props.space.id, props.taskId);
  const task = spaceLiveTask(props.roomTask, view.data?.task ?? null);
  const threads = mergeSpaceThreads(props.roomThreads, view.data?.threads ?? EMPTY_THREADS);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <WorkspacePageHeader electron={isElectron}>
        <WorkspaceBreadcrumb ariaLabel="Task" className="flex-1">
          <WorkspaceBreadcrumbItem>
            <Link
              to="/spaces/$environmentId/$spaceId"
              params={{ environmentId: props.environmentId, spaceId: props.space.id }}
              className="truncate rounded-sm hover:text-foreground"
            >
              {props.space.name}
            </Link>
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
          <WorkspaceBreadcrumbItem current className="min-w-0">
            <WorkspaceBreadcrumbText>{task?.title ?? "Task"}</WorkspaceBreadcrumbText>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        {task === null ? null : (
          <TaskMenu
            environmentId={props.environmentId}
            space={props.space}
            task={task}
            viewer={props.viewer}
            canOperate={props.controls.canCreateTask}
          />
        )}
        {props.panelHidden ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Show panel"
            onClick={props.onShowPanel}
          >
            <PanelRightOpenIcon />
          </Button>
        ) : null}
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {task === null ? (
          <p className="p-6 text-muted-foreground text-sm">
            {view.error === null || view.error === undefined
              ? "Loading the task…"
              : "This task isn't here any more."}
          </p>
        ) : (
          <TaskBody
            environmentId={props.environmentId}
            space={props.space}
            task={task}
            threads={threads}
            entries={spaceTaskEntries(view.data?.entries ?? [], props.roomEntries, props.taskId)}
            viewer={props.viewer}
            controls={props.controls}
          />
        )}
      </div>
    </div>
  );
}

function useTaskAction(environmentId: EnvironmentId) {
  const run = useAtomCommand(spaceEnvironment.task, "Update task");
  const [busy, setBusy] = useState(false);
  const act = async (action: SpaceTaskAction, failure: string) => {
    setBusy(true);
    const result = await run({ environmentId, input: action });
    setBusy(false);
    toastCommandFailure(failure, result);
    return result._tag === "Success";
  };
  return { busy, act };
}

function TaskMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly task: SpaceTask;
  readonly viewer: SpaceViewer;
  readonly canOperate: boolean;
}) {
  const { task, space, viewer } = props;
  const controls = spaceTaskControls(task, space, viewer.memberId, props.canOperate);
  const setStatus = useSetSpaceTaskStatus(props.environmentId);
  const { act } = useTaskAction(props.environmentId);
  const [editing, setEditing] = useState(false);
  const ref = { spaceId: space.id, taskId: task.id };
  return (
    <>
      <Menu>
        <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="Task actions" />}>
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={() => void copySpaceTaskLink(props.environmentId, task)}>
            <LinkIcon />
            Copy link
          </MenuItem>
          {controls.canReassign ? (
            <MenuSub>
              <MenuSubTrigger>
                <UserRoundIcon />
                Reassign
              </MenuSubTrigger>
              <MenuSubPopup>
                {orderSpaceMembers(space)
                  .filter((member) => member.memberId !== task.ownerId)
                  .map((member) => (
                    <MenuItem
                      key={member.memberId}
                      onClick={() =>
                        void act(
                          { type: "reassign", ...ref, ownerId: member.memberId },
                          "Could not reassign",
                        )
                      }
                    >
                      {member.memberId === viewer.memberId ? "You" : viewer.nameOf(member.memberId)}
                    </MenuItem>
                  ))}
              </MenuSubPopup>
            </MenuSub>
          ) : null}
          {controls.canEdit ? (
            <MenuItem onClick={() => setEditing(true)}>
              <PencilIcon />
              Edit title and description
            </MenuItem>
          ) : null}
          {controls.canCancel ? (
            <>
              <MenuSeparator />
              <MenuItem variant="destructive" onClick={() => void setStatus(task, "canceled")}>
                <CircleXIcon />
                Cancel task
              </MenuItem>
            </>
          ) : null}
        </MenuPopup>
      </Menu>
      {editing ? (
        <EditTaskDialog
          title={task.title}
          description={task.description}
          onClose={() => setEditing(false)}
          onSubmit={(title, description) =>
            act({ type: "edit", ...ref, title, description }, "Could not save")
          }
        />
      ) : null}
    </>
  );
}

function TaskBody(props: {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly task: SpaceTask;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly entries: ReadonlyArray<SpaceRoomEntry>;
  readonly viewer: SpaceViewer;
  readonly controls: SpaceControls;
}) {
  const { task, space, viewer } = props;
  const roster = useTeamMembers(props.environmentId);
  const projects = useSpaceProjects(props.environmentId);
  const setStatus = useSetSpaceTaskStatus(props.environmentId);
  const { busy, act } = useTaskAction(props.environmentId);
  const [showAll, setShowAll] = useState(false);
  const [handingBack, setHandingBack] = useState(false);
  const controls = spaceTaskControls(task, space, viewer.memberId, props.controls.canCreateTask);
  const status = spaceTaskStatusInfo(task.status);
  const notice = spaceTaskAssignmentNotice(task, props.threads.length, viewer);
  const merged = spaceMergedSuggestion(task, props.threads);
  const assignedAt = spaceTaskAssignedAt(task, props.entries);
  const ref = { spaceId: space.id, taskId: task.id };
  const colorOf = (memberId: MemberId) => roster.get(memberId)?.color ?? "var(--muted-foreground)";
  const nameOf = (memberId: MemberId) =>
    memberId === viewer.memberId ? "You" : viewer.nameOf(memberId);
  const pullRequests = props.threads.flatMap((thread) =>
    (thread.pullRequests ?? []).filter((link) => link.source !== "stack-dismissed"),
  );
  const records = props.entries.filter(isSpaceTaskLineEntry);
  const recordContext: SpaceRecordContext = {
    viewer,
    inThread: null,
    onTask: task.id,
    threadTitle: (threadId) => props.threads.find((t) => t.id === threadId)?.title ?? null,
    undone: spaceUndoneEntryIds(props.entries),
  };
  const longDescription = task.description.length > 280 || task.description.split("\n").length > 4;
  const startThread = () =>
    openSpaceThreadDialog({
      type: "start",
      environmentId: props.environmentId,
      spaceId: space.id,
      taskId: task.id,
    });
  const reassignMenu = (label: string) =>
    controls.canReassign ? (
      <Menu>
        <MenuTrigger render={<Button size="xs" variant="outline" disabled={busy} />}>
          {label}
        </MenuTrigger>
        <MenuPopup align="end">
          {orderSpaceMembers(space)
            .filter((member) => member.memberId !== task.ownerId)
            .map((member) => (
              <MenuItem
                key={member.memberId}
                onClick={() =>
                  void act(
                    { type: "reassign", ...ref, ownerId: member.memberId },
                    "Could not reassign",
                  )
                }
              >
                {nameOf(member.memberId)}
              </MenuItem>
            ))}
        </MenuPopup>
      </Menu>
    ) : null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-semibold text-base leading-snug">{task.title}</h1>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
          {controls.canSetStatus ? (
            <SpaceStatusMenu
              status={task.status}
              onPick={(next) => void setStatus(task, next)}
              trigger={
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Status: ${status.label}. Change status`}
                />
              }
            >
              <SpaceTaskStatusGlyph icon={status.icon} tone={status.tone} />
              {status.label}
              <ChevronDownIcon />
            </SpaceStatusMenu>
          ) : (
            <span className="flex items-center gap-1.5 text-foreground">
              <SpaceTaskStatusGlyph icon={status.icon} tone={status.tone} />
              {status.label}
            </span>
          )}
          {controls.canReassign ? (
            <Menu>
              <MenuTrigger
                render={<Button size="xs" variant="ghost" aria-label="Owner. Reassign" />}
              >
                <MemberAvatar
                  size="sm"
                  member={{ name: viewer.nameOf(task.ownerId), color: colorOf(task.ownerId) }}
                />
                {nameOf(task.ownerId)}
              </MenuTrigger>
              <MenuPopup align="start">
                {orderSpaceMembers(space).map((member) => (
                  <MenuItem
                    key={member.memberId}
                    disabled={member.memberId === task.ownerId}
                    onClick={() =>
                      void act(
                        { type: "reassign", ...ref, ownerId: member.memberId },
                        "Could not reassign",
                      )
                    }
                  >
                    {nameOf(member.memberId)}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          ) : (
            <span className="flex items-center gap-1.5 text-foreground">
              <MemberAvatar
                size="sm"
                member={{ name: viewer.nameOf(task.ownerId), color: colorOf(task.ownerId) }}
              />
              {nameOf(task.ownerId)}
            </span>
          )}
          <span>
            Created by {task.createdBy === viewer.memberId ? "you" : viewer.nameOf(task.createdBy)}{" "}
            · <RelativeTime timestamp={task.createdAt} />
          </span>
          {pullRequests.map((link) => (
            <a
              key={`${link.repository}#${link.number}`}
              href={link.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 hover:text-foreground"
            >
              <PullRequestGlyph.pullRequest aria-hidden className="size-3.5" />
              {spacePullRequestLabel(link)}
            </a>
          ))}
        </div>
      </div>

      <div className="flex flex-col items-start gap-1">
        <p
          className={
            showAll || !longDescription
              ? "whitespace-pre-wrap break-words text-sm"
              : "line-clamp-4 whitespace-pre-wrap break-words text-sm"
          }
        >
          {task.description}
        </p>
        {longDescription ? (
          <Button size="micro" variant="ghost-muted" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Show less" : "Show more"}
          </Button>
        ) : null}
      </div>

      {notice === null ? null : (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm"
        >
          <span className="min-w-0 flex-1">
            {notice.text}
            {notice.type === "waiting" && assignedAt !== null ? (
              <span className="text-muted-foreground">
                {" "}
                · assigned <RelativeTime timestamp={assignedAt} />
              </span>
            ) : null}
            {notice.type === "waiting" && task.remindedAt !== null ? (
              <span className="text-muted-foreground">
                {" "}
                · reminded <RelativeTime timestamp={task.remindedAt} />
              </span>
            ) : null}
          </span>
          {notice.type === "assigned-to-you" ? (
            <>
              {controls.canHandBack ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setHandingBack(true)}
                >
                  Can't take it
                </Button>
              ) : null}
              {controls.canStartThread ? (
                <Button size="xs" onClick={startThread}>
                  Start a thread
                </Button>
              ) : null}
            </>
          ) : notice.type === "waiting" ? (
            <>
              {controls.canRemind ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={async () => {
                    if (await act({ type: "remind", ...ref }, "Could not remind")) {
                      toastManager.add({
                        type: "success",
                        title: `Reminded ${viewer.nameOf(task.ownerId)}`,
                      });
                    }
                  }}
                >
                  Remind {viewer.nameOf(task.ownerId)}
                </Button>
              ) : null}
              {reassignMenu("Reassign")}
            </>
          ) : (
            reassignMenu("Reassign")
          )}
        </div>
      )}

      {merged === null || !controls.canSetStatus ? null : (
        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          <PullRequestGlyph.merged aria-hidden className="size-3.5" />
          <span>{merged.text}</span>
          <span>·</span>
          <Button size="micro" variant="ghost" onClick={() => void setStatus(task, merged.status)}>
            {merged.action}
          </Button>
        </div>
      )}

      <section className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 className="flex-1 font-medium text-sm">
            Threads{" "}
            <span className="font-normal text-muted-foreground">{props.threads.length}</span>
          </h2>
          {controls.canAttachThread ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                openSpaceThreadDialog({
                  type: "attach",
                  environmentId: props.environmentId,
                  threadId: null,
                  target: ref,
                })
              }
            >
              Add existing thread
            </Button>
          ) : null}
          {controls.canStartThread ? (
            <Button size="xs" variant="outline" onClick={startThread}>
              <PlusIcon />
              Start a thread
            </Button>
          ) : null}
        </div>
        {props.threads.length === 0 ? (
          <p className="py-2 text-muted-foreground text-sm">No threads yet.</p>
        ) : (
          props.threads.map((thread) => (
            <TaskThreadRow
              key={thread.id}
              environmentId={props.environmentId}
              space={space}
              task={task}
              thread={thread}
              viewer={viewer}
              canOperate={props.controls.canCreateTask}
              runsIn={spaceThreadRunsIn(thread, projects)}
              color={thread.ownerId == null ? null : colorOf(thread.ownerId)}
            />
          ))
        )}
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h2 className="flex-1 font-medium text-sm">Activity</h2>
          <Link
            to="/spaces/$environmentId/$spaceId"
            params={{ environmentId: props.environmentId, spaceId: space.id }}
            className="text-muted-foreground text-xs hover:text-foreground"
          >
            Discuss in the room
          </Link>
        </div>
        <div className="flex flex-col gap-1">
          {/* Until the lines load, or once the created line is past the page. */}
          {records.some((entry) => entry.line.type === "task-created") ? null : (
            <SpaceSystemLine createdAt={task.createdAt}>
              {task.createdBy === viewer.memberId ? "You" : viewer.nameOf(task.createdBy)} created
              this
            </SpaceSystemLine>
          )}
          {records.map((entry) => (
            <SpaceRecordLine
              key={entry.id}
              environmentId={props.environmentId}
              space={space}
              entry={entry}
              entries={props.entries}
              taskOf={(taskId) => (taskId === task.id ? task : null)}
              context={recordContext}
            />
          ))}
        </div>
      </section>

      {handingBack ? (
        <HandBackDialog
          assignerName={viewer.nameOf(task.assignedBy ?? task.createdBy)}
          onClose={() => setHandingBack(false)}
          onSubmit={(reason) =>
            act({ type: "hand-back", ...ref, reason }, "Could not hand it back")
          }
        />
      ) : null}
    </div>
  );
}

function TaskThreadRow(props: {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly task: SpaceTask;
  readonly thread: OrchestrationV2ThreadShell;
  readonly viewer: SpaceViewer;
  readonly canOperate: boolean;
  readonly runsIn: string | null;
  readonly color: string | null;
}) {
  const { thread, viewer } = props;
  const linkThread = useAtomCommand(spaceEnvironment.linkThread, "Remove thread from task");
  const activity = spaceThreadActivityView(thread, viewer);
  const controls = spaceThreadControls(
    thread,
    props.task,
    props.space,
    viewer.memberId,
    props.canOperate,
  );
  const owner = thread.ownerId ?? null;
  const remove = async () => {
    const result = await linkThread({
      environmentId: props.environmentId,
      input: { threadId: thread.id, target: null },
    });
    toastCommandFailure("Could not remove the thread", result);
    if (result._tag !== "Success") return;
    const id = toastManager.add({
      type: "success",
      title: `Removed from ${props.task.title}`,
      actionProps: {
        children: "Undo",
        onClick: () => {
          toastManager.close(id);
          void linkThread({
            environmentId: props.environmentId,
            input: {
              threadId: thread.id,
              target: { spaceId: props.space.id, taskId: props.task.id },
            },
          }).then((undone) => toastCommandFailure("Could not undo", undone));
        },
      },
    });
  };
  return (
    <div className="group/thread relative flex min-h-11 items-center gap-2 rounded-md px-2 hover:bg-accent">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId: props.environmentId, threadId: thread.id }}
            className="min-w-0 flex-1 truncate text-sm after:absolute after:inset-0"
          >
            {thread.title}
          </Link>
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
            <RelativeTime timestamp={DateTime.formatIso(thread.updatedAt)} />
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
          {owner === null ? null : (
            <>
              <MemberAvatar
                size="sm"
                className="size-3.5"
                member={{
                  name: viewer.nameOf(owner),
                  color: props.color ?? "var(--muted-foreground)",
                }}
              />
              <span className="shrink-0">
                {owner === viewer.memberId ? "You" : viewer.nameOf(owner)}
              </span>
            </>
          )}
          {props.runsIn === null ? null : <span className="shrink-0">· {props.runsIn}</span>}
          <span>·</span>
          {activity.glyph === null ? null : (
            <SpaceActivityIcon glyph={activity.glyph} tone={activity.tone} />
          )}
          <span
            className={
              activity.needsViewer ? "truncate font-medium text-warning-foreground" : "truncate"
            }
          >
            {activity.text}
          </span>
        </div>
      </div>
      {controls.canMove || controls.canRemove ? (
        <div className="relative">
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Actions for ${thread.title}`}
                />
              }
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              {controls.canMove ? (
                <MenuItem
                  onClick={() =>
                    openSpaceThreadDialog({
                      type: "attach",
                      environmentId: props.environmentId,
                      threadId: thread.id,
                      target: null,
                      fromTaskId: props.task.id,
                    })
                  }
                >
                  Move to another task…
                </MenuItem>
              ) : null}
              {controls.canRemove ? (
                <MenuItem variant="destructive" onClick={() => void remove()}>
                  Remove from task
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
        </div>
      ) : null}
    </div>
  );
}

function HandBackDialog(props: {
  readonly assignerName: string;
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
            It goes back to {props.assignerName}, with your reason in the room.
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
              aria-label="Description"
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
