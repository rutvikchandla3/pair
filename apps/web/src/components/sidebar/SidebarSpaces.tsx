import {
  type SpaceOverviewRow,
  isSpaceOwner,
  spaceSidebarTasks,
  spaceTaskStatusInfo,
} from "@t3tools/client-runtime/spaces";
import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  Space,
  SpaceId,
  SpaceTask,
} from "@t3tools/contracts";
import { Link, useParams } from "@tanstack/react-router";
import { ArchiveRestoreIcon, MoreHorizontalIcon, PlusIcon, UsersRoundIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { openSpaceDialog } from "../../spaceDialogStore";
import {
  spaceEnvironment,
  useCanOperateSpaces,
  useSpaceEnvironmentIds,
  useSpaceListWithOpenRoom,
  useSpaceSidebarShells,
  useSpaceViewer,
} from "../../state/spaces";
import { useAtomCommand } from "../../state/use-atom-command";
import { SpaceTaskStatusGlyph } from "../spaces/SpaceStatusIcon";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

const rowClass =
  "group/space-row flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-sm text-sidebar-foreground hover:bg-sidebar-row-hover data-[status=active]:bg-sidebar-row-active";

/** Spaces live on Pair Cloud, so the section shows only where one is connected. */
export function SidebarSpaces() {
  const environmentIds = useSpaceEnvironmentIds();
  return (
    <>
      {environmentIds.map((environmentId) => (
        <SidebarSpacesForEnvironment key={environmentId} environmentId={environmentId} />
      ))}
    </>
  );
}

function TaskLink(props: {
  readonly environmentId: EnvironmentId;
  readonly task: SpaceTask;
  readonly needsYou?: boolean;
}) {
  const { task } = props;
  const status = spaceTaskStatusInfo(task.status);
  return (
    <Link
      to="/spaces/$environmentId/$spaceId/tasks/$taskId"
      params={{ environmentId: props.environmentId, spaceId: task.spaceId, taskId: task.id }}
      className={cn(rowClass, "ps-7")}
    >
      <SpaceTaskStatusGlyph icon={status.icon} tone={status.tone} label={status.label} />
      <span className="min-w-0 flex-1 truncate">{task.title}</span>
      {props.needsYou ? (
        <span className="shrink-0 text-input-foreground text-xs">Needs you</span>
      ) : null}
    </Link>
  );
}

/** A task that needs the viewer, with the threads on it; others' say whose they are. */
function NeedsYouRow(props: {
  readonly environmentId: EnvironmentId;
  readonly row: SpaceOverviewRow<OrchestrationV2ThreadShell>;
  readonly viewerId: string | null;
  readonly nameOf: (memberId: NonNullable<OrchestrationV2ThreadShell["ownerId"]>) => string;
}) {
  return (
    <li>
      <TaskLink environmentId={props.environmentId} task={props.row.task} needsYou />
      {props.row.threads.length > 0 ? (
        <ul className="flex flex-col gap-px">
          {props.row.threads.map((thread) => {
            const ownerId = thread.ownerId;
            const theirs = ownerId != null && ownerId !== props.viewerId;
            return (
              <li key={thread.id}>
                <Link
                  to="/$environmentId/$threadId"
                  params={{ environmentId: props.environmentId, threadId: thread.id }}
                  className={cn(rowClass, "h-auto min-h-7 flex-col items-start gap-0 py-1 ps-12")}
                >
                  <span className="w-full truncate">{thread.title}</span>
                  {theirs && ownerId != null ? (
                    <span className="w-full truncate text-sidebar-muted-foreground text-xs">
                      {props.nameOf(ownerId)}'s thread
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

function SidebarSpacesForEnvironment(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const params = useParams({ strict: false });
  const routeSpaceId =
    params.environmentId === environmentId && params.spaceId !== undefined
      ? (params.spaceId as SpaceId)
      : null;
  const list = useSpaceListWithOpenRoom(environmentId, routeSpaceId);
  const spaces = list.spaces;
  const shells = useSpaceSidebarShells(environmentId);
  const viewer = useSpaceViewer(environmentId);
  const canOperate = useCanOperateSpaces(environmentId);
  const [assignedOpen, setAssignedOpen] = useState(false);
  const [spacesOpen, setSpacesOpen] = useState(true);
  const [archivedOpen, setArchivedOpen] = useState(false);

  const activeSpaces = spaces.filter((space) => space.archivedAt === null);
  const archived = spaces.filter((space) => space.archivedAt !== null);
  const sidebar = spaceSidebarTasks(list, shells.taskThreads, viewer);
  const assigned = sidebar.assignedToMe;
  const openSpaceId =
    params.environmentId !== environmentId
      ? null
      : (params.spaceId ??
        shells.taskThreads.find((thread) => thread.id === params.threadId)?.space?.spaceId ??
        null);

  return (
    <div className="mb-2 flex flex-col gap-px" role="presentation">
      <button
        type="button"
        aria-expanded={assignedOpen}
        className={cn(rowClass, "w-full text-left")}
        onClick={() => setAssignedOpen(!assignedOpen)}
      >
        <span className="flex-1 truncate">Assigned to me</span>
        {assigned.length > 0 ? (
          <span className="rounded-full bg-input-foreground/12 px-1.5 text-input-foreground text-xs tabular-nums">
            {assigned.length}
          </span>
        ) : null}
      </button>
      {assignedOpen ? (
        <ul className="flex flex-col gap-px">
          {assigned.length === 0 ? (
            <li className="px-7 py-1 text-sidebar-muted-foreground text-xs">
              No open tasks are yours.
            </li>
          ) : (
            assigned.map((task) => (
              <li key={task.id}>
                <TaskLink environmentId={environmentId} task={task} />
              </li>
            ))
          )}
        </ul>
      ) : null}
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <CollapsibleSectionHeader
            expanded={spacesOpen}
            onClick={() => setSpacesOpen(!spacesOpen)}
          >
            Spaces
          </CollapsibleSectionHeader>
        </div>
        {canOperate ? (
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label="New space"
            onClick={() => openSpaceDialog({ type: "new-space", environmentId })}
          >
            <PlusIcon />
          </Button>
        ) : null}
      </div>
      {spacesOpen ? (
        <ul className="flex flex-col gap-px">
          {activeSpaces.length === 0 ? (
            <li className="px-2 py-1 text-sidebar-muted-foreground text-xs">
              Rooms where your team and Pair work together.
            </li>
          ) : null}
          {activeSpaces.map((space) => {
            const tasks = space.id === openSpaceId ? sidebar.spaces.get(space.id) : undefined;
            return (
              <li key={space.id}>
                <SpaceRow
                  environmentId={environmentId}
                  space={space}
                  unread={shells.unreadRoomIds.has(space.roomThreadId)}
                />
                {tasks === undefined ? null : (
                  <ul className="flex flex-col gap-px">
                    {tasks.needsYou.map((row) => (
                      <NeedsYouRow
                        key={row.task.id}
                        environmentId={environmentId}
                        row={row}
                        viewerId={viewer.memberId}
                        nameOf={viewer.nameOf}
                      />
                    ))}
                    {tasks.more > 0 ? (
                      <li>
                        <Link
                          to="/spaces/$environmentId/$spaceId"
                          params={{ environmentId, spaceId: space.id }}
                          className={cn(rowClass, "ps-7 text-sidebar-muted-foreground text-xs")}
                        >
                          {tasks.more} more {tasks.more === 1 ? "task" : "tasks"}
                        </Link>
                      </li>
                    ) : null}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {archived.length > 0 ? (
        <>
          <CollapsibleSectionHeader
            expanded={archivedOpen}
            onClick={() => setArchivedOpen(!archivedOpen)}
          >
            Archived
          </CollapsibleSectionHeader>
          {archivedOpen ? (
            <ul className="flex flex-col gap-px">
              {archived.map((space) => (
                <li key={space.id}>
                  <SpaceRow
                    environmentId={environmentId}
                    space={space}
                    unread={false}
                    archivedActions={isSpaceOwner(space, viewer.memberId) && canOperate}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function SpaceRow(props: {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly unread: boolean;
  readonly archivedActions?: boolean;
}) {
  const mutate = useAtomCommand(spaceEnvironment.mutate, "Unarchive space");
  const unarchive = async () => {
    const result = await mutate({
      environmentId: props.environmentId,
      input: { type: "unarchive", spaceId: props.space.id },
    });
    toastCommandFailure("Could not unarchive", result);
  };
  return (
    <div className="relative">
      <Link
        to="/spaces/$environmentId/$spaceId"
        params={{ environmentId: props.environmentId, spaceId: props.space.id }}
        className={cn(rowClass, props.space.archivedAt !== null && "text-sidebar-muted-foreground")}
      >
        <UsersRoundIcon className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
        <span className={cn("min-w-0 flex-1 truncate", props.unread && "font-medium")}>
          {props.space.name}
        </span>
        {props.unread ? (
          <span
            aria-label="Unread"
            className="size-1.5 shrink-0 rounded-full bg-input-foreground"
          />
        ) : null}
      </Link>
      {props.archivedActions ? (
        <div className="absolute inset-y-0 right-1 hidden items-center has-data-popup-open:flex [div:hover>&]:flex">
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost-muted"
                  aria-label={`Actions for ${props.space.name}`}
                />
              }
            >
              <MoreHorizontalIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => void unarchive()}>
                <ArchiveRestoreIcon />
                Unarchive
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      ) : null}
    </div>
  );
}
