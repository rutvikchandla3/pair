import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type SpaceRecordContext,
  isSpaceTaskLineEntry,
  spaceControls,
  spaceTaskStatusInfo,
  spaceTaskControls,
  spaceThreadControls,
  spaceUndoneEntryIds,
} from "@t3tools/client-runtime/spaces";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  MemberId,
  ScopedThreadRef,
  Space,
  SpaceTask,
  ThreadId,
  ThreadSpaceTask,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { EllipsisIcon, LayoutListIcon, ListPlusIcon } from "lucide-react";

import { useRightPanelStore } from "../../rightPanelStore";
import { openSpaceDialog } from "../../spaceDialogStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readThreadShell, useThreadShell } from "../../state/entities";
import {
  spaceEnvironment,
  useCanOperateSpaces,
  useSpaceEnvironmentIds,
  useSpaceListResult,
  useSpaceTaskThreads,
  useSpaceTaskView,
  useSpaceViewer,
} from "../../state/spaces";
import { teamEnvironment } from "../../state/team";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import {
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { SpaceRecordLine, SpaceTaskChip } from "./SpaceRecord";
import { SpaceOverview } from "./SpaceRoomPanel";
import { SpaceTaskStatusGlyph } from "./SpaceStatusIcon";
import { openSpaceThreadDialog } from "./spaceThreadDialogStore";

export interface SpaceThreadTask {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly ownerId: OwnerId;
  readonly placement: ThreadSpaceTask;
  readonly space: Space;
  readonly task: SpaceTask | null;
}

type OwnerId = NonNullable<ReturnType<typeof useThreadShell>>["source"]["ownerId"];

/** A thread on a task: its link, space and task; null for any other thread. */
export function useSpaceThreadTask(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): SpaceThreadTask | null {
  const shell = useThreadShell(
    environmentId === null || threadId === null ? null : scopeThreadRef(environmentId, threadId),
  );
  const placement = shell?.source.space;
  const list = useSpaceListResult(placement?.kind === "task" ? environmentId : null);
  if (shell === null || environmentId === null || placement?.kind !== "task") return null;
  const space = list.spaces.find((candidate) => candidate.id === placement.spaceId);
  if (space === undefined) return null;
  return {
    environmentId,
    threadId: shell.id,
    ownerId: shell.source.ownerId,
    placement,
    space,
    task: list.tasks.find((candidate) => candidate.id === placement.taskId) ?? null,
  };
}

/** For the composer: someone else's thread on a task keeps its owner's model, and Stop asks. */
export function useSpaceThreadComposerLock(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
) {
  const context = useSpaceThreadTask(environmentId, threadId);
  const viewer = useSpaceViewer(environmentId);
  const canOperate = useCanOperateSpaces(environmentId);
  if (context === null || context.task === null) return null;
  const controls = spaceThreadControls(
    { ownerId: context.ownerId },
    context.task,
    context.space,
    viewer.memberId,
    canOperate,
  );
  if (!controls.modelLocked) return null;
  const ownerName = context.ownerId == null ? "the owner" : viewer.nameOf(context.ownerId);
  return { ownerName, stopNeedsConfirm: controls.stopNeedsConfirm };
}

/** "Space / Task /" before the thread's title, with the task's read-only status. */
export function SpaceThreadCrumb(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const context = useSpaceThreadTask(props.environmentId, props.threadId);
  if (context === null) return null;
  const status = context.task === null ? null : spaceTaskStatusInfo(context.task.status);
  return (
    <>
      <WorkspaceBreadcrumbItem className="shrink">
        <Link
          to="/spaces/$environmentId/$spaceId"
          params={{ environmentId: props.environmentId, spaceId: context.space.id }}
          className="truncate rounded-sm text-muted-foreground hover:text-foreground"
        >
          <WorkspaceBreadcrumbText>{context.space.name}</WorkspaceBreadcrumbText>
        </Link>
      </WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator>
        <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
      </WorkspaceBreadcrumbSeparator>
      <WorkspaceBreadcrumbItem className="shrink gap-1.5">
        <Link
          to="/spaces/$environmentId/$spaceId/tasks/$taskId"
          params={{
            environmentId: props.environmentId,
            spaceId: context.space.id,
            taskId: context.placement.taskId,
          }}
          aria-label={status === null ? undefined : `Task, ${status.label}`}
          className="flex min-w-0 items-center gap-1.5 truncate rounded-sm text-muted-foreground hover:text-foreground"
        >
          {status === null ? null : (
            <SpaceTaskStatusGlyph icon={status.icon} tone={status.tone} label={status.label} />
          )}
          <WorkspaceBreadcrumbText className="max-w-48">
            {context.task?.title ?? "Task"}
          </WorkspaceBreadcrumbText>
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

/** Whether the viewer can add this thread to a task: their own, in a space environment. */
function useCanAddThreadToTask(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): boolean {
  const shell = useThreadShell(
    environmentId === null || threadId === null ? null : scopeThreadRef(environmentId, threadId),
  );
  const spaceEnvironments = useSpaceEnvironmentIds();
  const viewer = useSpaceViewer(environmentId);
  const canOperate = useCanOperateSpaces(environmentId);
  return (
    shell !== null &&
    environmentId !== null &&
    canOperate &&
    spaceEnvironments.includes(environmentId) &&
    shell.source.space === undefined &&
    shell.archivedAt === null &&
    viewer.memberId !== null &&
    shell.source.ownerId === viewer.memberId
  );
}

/** Removes a thread from its task, with Undo putting it back. */
export async function removeThreadFromTask(context: SpaceThreadTask) {
  const link = (target: { spaceId: Space["id"]; taskId: SpaceTask["id"] } | null) =>
    runAtomCommand(
      appAtomRegistry,
      spaceEnvironment.linkThread,
      { environmentId: context.environmentId, input: { threadId: context.threadId, target } },
      { label: "Remove thread from task" },
    );
  const result = await link(null);
  toastCommandFailure("Could not remove the thread", result);
  if (result._tag !== "Success") return;
  const id = toastManager.add({
    type: "success",
    title: `Removed from ${context.task?.title ?? "the task"}`,
    description: `Stops sharing it with ${context.space.name}.`,
    actionProps: {
      children: "Undo",
      onClick: () => {
        toastManager.close(id);
        void link({ spaceId: context.space.id, taskId: context.placement.taskId }).then((undone) =>
          toastCommandFailure("Could not undo", undone),
        );
      },
    },
  });
}

function spaceThreadActionsOf(
  context: SpaceThreadTask,
  memberId: MemberId | null,
  canOperate: boolean,
) {
  const thread = spaceThreadControls(
    { ownerId: context.ownerId },
    context.task ?? { ownerId: context.placement.linkedBy },
    context.space,
    memberId,
    canOperate,
  );
  const task =
    context.task === null
      ? null
      : spaceTaskControls(context.task, context.space, memberId, canOperate);
  return {
    context,
    canAdd: false,
    canMove: thread.canMove,
    canRemove: thread.canRemove,
    canSetStatus: task?.canSetStatus ?? false,
    canStartThread: task?.canStartThread ?? false,
  };
}

/** What the viewer can do with a thread and its task, for the header and the palette. */
export function useSpaceThreadActions(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
) {
  const context = useSpaceThreadTask(environmentId, threadId);
  const canAdd = useCanAddThreadToTask(environmentId, threadId);
  const viewer = useSpaceViewer(environmentId);
  const canOperate = useCanOperateSpaces(environmentId);
  if (context === null) {
    return {
      context,
      canAdd,
      canMove: false,
      canRemove: false,
      canSetStatus: false,
      canStartThread: false,
    };
  }
  return spaceThreadActionsOf(context, viewer.memberId, canOperate);
}

/** For imperative menus: the same actions from the cached list, or null off a task. */
export function readSpaceThreadActions(environmentId: EnvironmentId, threadId: ThreadId) {
  const placement = readThreadShell(scopeThreadRef(environmentId, threadId));
  if (placement === null || placement.source.space?.kind !== "task") return null;
  const link = placement.source.space;
  const list = AsyncResult.getOrElse(
    appAtomRegistry.get(spaceEnvironment.list({ environmentId, input: undefined })),
    () => null,
  );
  const space = list?.spaces.find((candidate) => candidate.id === link.spaceId);
  if (list === null || space === undefined) return null;
  const context: SpaceThreadTask = {
    environmentId,
    threadId,
    ownerId: placement.source.ownerId,
    placement: link,
    space,
    task: list.tasks.find((candidate) => candidate.id === link.taskId) ?? null,
  };
  return spaceThreadActionsOf(
    context,
    appAtomRegistry.get(teamEnvironment.currentMemberIdAtom(environmentId)),
    appAtomRegistry.get(spaceEnvironment.post.permissionAtom(environmentId)),
  );
}

/** The header's "Add to task", or ⋯ Move / Remove for a thread on a task. */
export function SpaceThreadHeaderActions(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const actions = useSpaceThreadActions(props.environmentId, props.threadId);
  const { context } = actions;
  if (context === null) {
    if (!actions.canAdd) return null;
    return (
      <Button
        size="xs"
        variant="ghost"
        onClick={() =>
          openSpaceThreadDialog({
            type: "attach",
            environmentId: props.environmentId,
            threadId: props.threadId,
            target: null,
          })
        }
      >
        <ListPlusIcon />
        Add to task
      </Button>
    );
  }
  const controls = actions;
  if (!controls.canMove && !controls.canRemove) return null;
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="icon-xs" variant="ghost-muted" aria-label="Task actions" />}
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
                threadId: props.threadId,
                target: null,
                fromTaskId: context.placement.taskId,
              })
            }
          >
            ↳ Move to another task…
          </MenuItem>
        ) : null}
        {controls.canRemove ? (
          <MenuItem variant="destructive" onClick={() => void removeThreadFromTask(context)}>
            Remove from task
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/** Above the first message: how the thread came to the task. */
export function SpaceThreadBanner(props: { readonly context: SpaceThreadTask }) {
  const { context } = props;
  const viewer = useSpaceViewer(context.environmentId);
  const view = useSpaceTaskView(context.environmentId, context.space.id, context.placement.taskId);
  const task = view.data?.task ?? context.task;
  const linker =
    context.placement.linkedBy === viewer.memberId
      ? "You"
      : viewer.nameOf(context.placement.linkedBy);
  return (
    <p className="chat-content-lane flex flex-wrap items-center gap-1.5 py-2 text-muted-foreground text-xs">
      {linker}{" "}
      {context.placement.via === "start" ? "started this thread on" : "added this thread to"}
      <SpaceTaskChip
        environmentId={context.environmentId}
        spaceId={context.space.id}
        taskId={context.placement.taskId}
        task={task}
      />
    </p>
  );
}

/** At the timeline's end: the task's lines about this thread. */
export function SpaceThreadRecords(props: { readonly context: SpaceThreadTask }) {
  const { context } = props;
  const viewer = useSpaceViewer(context.environmentId);
  const view = useSpaceTaskView(context.environmentId, context.space.id, context.placement.taskId);
  const entries = view.data?.entries ?? [];
  const task = view.data?.task ?? context.task;
  const records = entries.filter(
    (entry) =>
      isSpaceTaskLineEntry(entry) &&
      (!("threadId" in entry.line) || entry.line.threadId === context.threadId),
  );
  const recordContext: SpaceRecordContext = {
    viewer,
    inThread: context.threadId,
    onTask: null,
    threadTitle: () => "this thread",
    undone: spaceUndoneEntryIds(entries),
  };
  if (records.length === 0) return null;
  return (
    <div className="chat-content-lane flex flex-col gap-1.5 py-2">
      {records.filter(isSpaceTaskLineEntry).map((entry) => (
        <SpaceRecordLine
          key={entry.id}
          environmentId={context.environmentId}
          space={context.space}
          entry={entry}
          entries={entries}
          taskOf={(taskId) => (taskId === task?.id ? task : null)}
          context={recordContext}
        />
      ))}
    </div>
  );
}

/** The space's Overview as a tab of the thread's right panel. */
export function SpaceThreadOverviewPanel(props: { readonly threadRef: ScopedThreadRef }) {
  const { environmentId, threadId } = props.threadRef;
  const context = useSpaceThreadTask(environmentId, threadId);
  if (context === null) {
    return <p className="p-4 text-muted-foreground text-sm">This thread isn't on a task.</p>;
  }
  return <OverviewFor context={context} />;
}

function OverviewFor(props: { readonly context: SpaceThreadTask }) {
  const { context } = props;
  const viewer = useSpaceViewer(context.environmentId);
  const canOperate = useCanOperateSpaces(context.environmentId);
  const list = useSpaceListResult(context.environmentId);
  const threads = useSpaceTaskThreads(context.environmentId, context.space.id, []);
  const controls = spaceControls(context.space, viewer.memberId, canOperate);
  return (
    <div className="h-full overflow-y-auto">
      <SpaceOverview
        environmentId={context.environmentId}
        space={context.space}
        tasks={list.tasks.filter((task) => task.spaceId === context.space.id)}
        threads={threads}
        viewer={viewer}
        canCreateTask={controls.canCreateTask}
        selectedTaskId={context.placement.taskId}
        onNewTask={() =>
          openSpaceDialog({
            type: "new-task",
            environmentId: context.environmentId,
            spaceId: context.space.id,
          })
        }
      />
    </div>
  );
}
