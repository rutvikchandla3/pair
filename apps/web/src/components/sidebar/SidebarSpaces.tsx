import { useAtomRefresh } from "@effect/atom-react";
import {
  type SpaceOverviewRow,
  isSpaceOwner,
  spaceTasksNeedingViewer,
} from "@t3tools/client-runtime/spaces";
import type { EnvironmentId, OrchestrationV2ThreadShell, Space } from "@t3tools/contracts";
import { Link, useParams } from "@tanstack/react-router";
import { ArchiveRestoreIcon, MoreHorizontalIcon, PlusIcon, UsersRoundIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { openSpaceDialog } from "../../spaceDialogStore";
import {
  spaceEnvironment,
  useCanOperateSpaces,
  useSpaceEnvironmentIds,
  useSpaceList,
  useSpaceSidebarShells,
  useSpaceViewer,
} from "../../state/spaces";
import { useAtomCommand } from "../../state/use-atom-command";
import { SpaceStatusIcon } from "../spaces/SpaceStatusIcon";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

const SUB_ROWS = 2;

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

function TaskRow(props: {
  readonly environmentId: EnvironmentId;
  readonly row: SpaceOverviewRow<OrchestrationV2ThreadShell>;
  readonly indent?: boolean;
}) {
  const { thread, status } = props.row;
  return (
    <li>
      <Link
        to="/$environmentId/$threadId"
        params={{ environmentId: props.environmentId, threadId: thread.id }}
        className={cn(rowClass, props.indent && "ps-7")}
      >
        <SpaceStatusIcon icon={status.icon} tone={status.tone} label={status.label} />
        <span className="truncate">{thread.title}</span>
      </Link>
    </li>
  );
}

function SidebarSpacesForEnvironment(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const spaces = useSpaceList(environmentId);
  const shells = useSpaceSidebarShells(environmentId);
  const viewer = useSpaceViewer(environmentId);
  const canOperate = useCanOperateSpaces(environmentId);
  const [assignedOpen, setAssignedOpen] = useState(false);
  const [spacesOpen, setSpacesOpen] = useState(true);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const refreshList = useAtomRefresh(spaceEnvironment.list({ environmentId, input: undefined }));
  const listedRooms = useRef(shells.roomsKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refetches the server's space list when a room is shared with or taken from this member
  useEffect(() => {
    if (listedRooms.current === shells.roomsKey) return;
    listedRooms.current = shells.roomsKey;
    refreshList();
  }, [shells.roomsKey, refreshList]);

  const activeSpaces = spaces.filter((space) => space.archivedAt === null);
  const archived = spaces.filter((space) => space.archivedAt !== null);
  // From the shells, not the list: a removed member still sees the tasks they kept.
  const needing = spaceTasksNeedingViewer(shells.tasks, viewer);
  const params = useParams({ strict: false });
  const openSpaceId =
    params.environmentId !== environmentId
      ? null
      : (params.spaceId ??
        shells.tasks.find((thread) => thread.id === params.threadId)?.space?.spaceId ??
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
        {needing.length > 0 ? (
          <span className="rounded-full bg-input-foreground/12 px-1.5 text-input-foreground text-xs tabular-nums">
            {needing.length}
          </span>
        ) : null}
      </button>
      {assignedOpen ? (
        <ul className="flex flex-col gap-px">
          {needing.length === 0 ? (
            <li className="px-7 py-1 text-sidebar-muted-foreground text-xs">Nothing needs you.</li>
          ) : (
            needing.map((row) => (
              <TaskRow key={row.thread.id} environmentId={environmentId} row={row} indent />
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
            const mine =
              space.id === openSpaceId
                ? needing.filter((row) => row.thread.space?.spaceId === space.id)
                : [];
            const shown = mine.slice(0, SUB_ROWS);
            const more = mine.length - shown.length;
            return (
              <li key={space.id}>
                <SpaceRow
                  environmentId={environmentId}
                  space={space}
                  unread={shells.unreadRoomIds.has(space.roomThreadId)}
                />
                {shown.length > 0 || more > 0 ? (
                  <ul className="flex flex-col gap-px">
                    {shown.map((row) => (
                      <TaskRow key={row.thread.id} environmentId={environmentId} row={row} indent />
                    ))}
                    {more > 0 ? (
                      <li>
                        <Link
                          to="/spaces/$environmentId/$spaceId"
                          params={{ environmentId, spaceId: space.id }}
                          className={cn(rowClass, "ps-7 text-sidebar-muted-foreground text-xs")}
                        >
                          {more} more
                        </Link>
                      </li>
                    ) : null}
                  </ul>
                ) : null}
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
