import {
  type SidebarSpaceRow,
  type SidebarSpaceRows,
  sidebarSpaceRows,
} from "@t3tools/client-runtime/inbox";
import { isSpaceOwner } from "@t3tools/client-runtime/spaces";
import type { EnvironmentId, MemberId, SpaceId } from "@t3tools/contracts";
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Link, useParams } from "@tanstack/react-router";
import {
  ArchiveRestoreIcon,
  ChevronRightIcon,
  InboxIcon,
  ListTodoIcon,
  MoreHorizontalIcon,
  PlusIcon,
  Share2Icon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "~/lib/utils";
import { SpaceMark } from "../spaces/SpaceMark";
import { openSpaceDialog } from "../../spaceDialogStore";
import { useInboxNeedsYouTotal, useInboxSummary, useTeamEnvironmentIds } from "../../state/inbox";
import {
  spaceEnvironment,
  useCanOperateSpaces,
  useSpaceEnvironmentIds,
  useSpaceListWithOpenRoom,
  useSpaceSidebarShells,
} from "../../state/spaces";
import { useCurrentMemberId } from "../../state/team";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUiStateStore } from "../../uiStateStore";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { reorderSidebarSpaces, sidebarSelectedSpaceId } from "./SidebarSpaces.logic";

const rowClass =
  "group/space-row flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-sm text-sidebar-foreground hover:bg-sidebar-row-hover";
const iconClass = "size-3.5 shrink-0 text-sidebar-muted-foreground";
const NO_ORDER: ReadonlyArray<SpaceId> = [];

/**
 * Team mode's places: Inbox, My tasks and Shared with you, then one row per space. Solo shows
 * none of it.
 */
export function SidebarSpaces() {
  const teamEnvironmentIds = useTeamEnvironmentIds();
  const spaceEnvironmentIds = useSpaceEnvironmentIds();
  const inboxCount = useInboxNeedsYouTotal(teamEnvironmentIds);
  if (teamEnvironmentIds.length === 0) return null;
  return (
    <div className="mb-2 flex flex-col gap-px" role="presentation">
      <SidebarPlaces inboxCount={inboxCount} />
      {spaceEnvironmentIds
        .filter((environmentId) => teamEnvironmentIds.includes(environmentId))
        .map((environmentId) => (
          <SidebarSpacesForEnvironment key={environmentId} environmentId={environmentId} />
        ))}
    </div>
  );
}

function PlaceLink(props: {
  readonly to: "/inbox" | "/my-tasks" | "/shared";
  readonly icon: ReactNode;
  readonly label: string;
  readonly trailing?: ReactNode;
}) {
  return (
    <Link
      to={props.to}
      activeOptions={{ exact: true }}
      className={cn(rowClass, "data-[status=active]:bg-sidebar-row-active")}
    >
      {props.icon}
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.trailing}
    </Link>
  );
}

/** The three fixed rows. Inbox's count is the only indigo number in the sidebar. */
function SidebarPlaces(props: { readonly inboxCount: number }) {
  return (
    <div className="mb-2 flex flex-col gap-px">
      <PlaceLink
        to="/inbox"
        icon={<InboxIcon className={iconClass} />}
        label="Inbox"
        trailing={
          props.inboxCount > 0 ? (
            <span
              aria-label={`${props.inboxCount} need you`}
              className="rounded-full bg-input-foreground/12 px-1.5 text-input-foreground text-xs tabular-nums"
            >
              {props.inboxCount}
            </span>
          ) : null
        }
      />
      <PlaceLink to="/my-tasks" icon={<ListTodoIcon className={iconClass} />} label="My tasks" />
      <PlaceLink to="/shared" icon={<Share2Icon className={iconClass} />} label="Shared with you" />
    </div>
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
  const shells = useSpaceSidebarShells(environmentId);
  const summary = useInboxSummary(environmentId);
  const viewerId = useCurrentMemberId(environmentId);
  const canOperate = useCanOperateSpaces(environmentId);
  const order = useUiStateStore(
    (store) => store.sidebarSpaceOrderByEnvironmentId[environmentId] as SpaceId[] | undefined,
  );
  const setOrder = useUiStateStore((store) => store.setSidebarSpaceOrder);
  const rows = sidebarSpaceRows(
    list.spaces,
    order ?? NO_ORDER,
    summary,
    shells.unreadRoomIds,
    viewerId,
  );
  const selectedSpaceId = sidebarSelectedSpaceId({
    environmentId,
    route: params,
    threadSpaceId: (threadId) =>
      shells.taskThreads.find((thread) => thread.id === threadId)?.space?.spaceId ?? null,
  });
  return (
    <SidebarSpaceList
      environmentId={environmentId}
      rows={rows}
      selectedSpaceId={selectedSpaceId}
      canOperate={canOperate}
      viewerId={viewerId}
      onReorder={(ids) => setOrder(environmentId, ids)}
    />
  );
}

/** The Spaces section: five rows, then "N more" that expands in place, archived ones last. */
export function SidebarSpaceList(props: {
  readonly environmentId: EnvironmentId;
  readonly rows: SidebarSpaceRows;
  readonly selectedSpaceId: SpaceId | null;
  readonly canOperate: boolean;
  readonly viewerId: MemberId | null;
  readonly onReorder: (ids: ReadonlyArray<SpaceId>) => void;
}) {
  const { environmentId, rows } = props;
  const [spacesOpen, setSpacesOpen] = useState(true);
  const [moreOpen, setMoreOpen] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const sortable = moreOpen ? [...rows.visible, ...rows.hidden] : rows.visible;
  const allIds = [...rows.visible, ...rows.hidden].map((row) => row.space.id);
  const moreCount = rows.hidden.length;
  const hasMore = moreCount > 0 || rows.archived.length > 0;
  const renderRow = (row: SidebarSpaceRow) => (
    <SortableSpaceRow
      key={row.space.id}
      environmentId={environmentId}
      row={row}
      selected={row.space.id === props.selectedSpaceId}
    />
  );
  const handleDragEnd = (event: DragEndEvent) => {
    if (event.over === null) return;
    const next = reorderSidebarSpaces(allIds, event.active.id as SpaceId, event.over.id as SpaceId);
    if (next !== allIds) props.onReorder(next);
  };

  return (
    <>
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <CollapsibleSectionHeader
            expanded={spacesOpen}
            onClick={() => setSpacesOpen(!spacesOpen)}
          >
            Spaces
          </CollapsibleSectionHeader>
        </div>
        {props.canOperate ? (
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
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <ul className="flex flex-col gap-px">
            {rows.visible.length === 0 ? (
              <li className="px-2 py-1 text-sidebar-muted-foreground text-xs">
                Rooms where your team and Pair work together.
              </li>
            ) : null}
            <SortableContext
              items={sortable.map((row) => row.space.id)}
              strategy={verticalListSortingStrategy}
            >
              {rows.visible.map(renderRow)}
              {hasMore ? (
                <li>
                  <button
                    type="button"
                    aria-expanded={moreOpen}
                    className={cn(rowClass, "w-full text-left text-sidebar-muted-foreground")}
                    onClick={() => setMoreOpen(!moreOpen)}
                  >
                    <ChevronRightIcon
                      className={cn(iconClass, "transition-transform", moreOpen && "rotate-90")}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {moreCount > 0 ? `${moreCount} more` : "Archived"}
                    </span>
                    {rows.hiddenNeedsYou > 0 ? (
                      <span className="text-xs tabular-nums">{rows.hiddenNeedsYou}</span>
                    ) : null}
                  </button>
                </li>
              ) : null}
              {moreOpen ? rows.hidden.map(renderRow) : null}
            </SortableContext>
            {moreOpen && rows.archived.length > 0 ? (
              <>
                {moreCount > 0 ? (
                  <li className="px-2 pt-2 pb-1 text-sidebar-muted-foreground text-xs">Archived</li>
                ) : null}
                {rows.archived.map((row) => (
                  <li key={row.space.id}>
                    <SpaceRow
                      environmentId={environmentId}
                      row={row}
                      selected={row.space.id === props.selectedSpaceId}
                      archivedActions={isSpaceOwner(row.space, props.viewerId) && props.canOperate}
                    />
                  </li>
                ))}
              </>
            ) : null}
          </ul>
        </DndContext>
      ) : null}
    </>
  );
}

function SortableSpaceRow(props: {
  readonly environmentId: EnvironmentId;
  readonly row: SidebarSpaceRow;
  readonly selected: boolean;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.row.space.id,
  });
  return (
    <li
      ref={setNodeRef}
      {...listeners}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && "relative z-10")}
    >
      <SpaceRow environmentId={props.environmentId} row={props.row} selected={props.selected} />
    </li>
  );
}

function SpaceRow(props: {
  readonly environmentId: EnvironmentId;
  readonly row: SidebarSpaceRow;
  readonly selected: boolean;
  readonly archivedActions?: boolean;
}) {
  const { space, needsYou, unread } = props.row;
  const mutate = useAtomCommand(spaceEnvironment.mutate, "Unarchive space");
  const unarchive = async () => {
    const result = await mutate({
      environmentId: props.environmentId,
      input: { type: "unarchive", spaceId: space.id },
    });
    toastCommandFailure("Could not unarchive", result);
  };
  return (
    <div className="relative">
      <Link
        to="/spaces/$environmentId/$spaceId"
        params={{ environmentId: props.environmentId, spaceId: space.id }}
        aria-current={props.selected ? "page" : undefined}
        className={cn(
          rowClass,
          props.selected && "bg-sidebar-row-active",
          space.archivedAt !== null && "text-sidebar-muted-foreground",
        )}
      >
        <SpaceMark
          space={space}
          size="xs"
          className={space.archivedAt !== null ? "opacity-60" : undefined}
        />
        <span className="min-w-0 flex-1 truncate">{space.name}</span>
        {needsYou > 0 ? (
          <span
            aria-label={`${needsYou} need you`}
            className="shrink-0 text-sidebar-muted-foreground text-xs tabular-nums"
          >
            {needsYou}
          </span>
        ) : unread ? (
          <span
            aria-label="Unread"
            className="size-1.5 shrink-0 rounded-full bg-sidebar-muted-foreground"
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
                  aria-label={`Actions for ${space.name}`}
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
