import { useAtomRefresh } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { spacePairFeedItems, spacePairRoom } from "@t3tools/client-runtime/spaceAgent";
import {
  type SpaceConfirm,
  type SpaceRoomMemberState,
  type SpaceViewer,
  joinedSpaceOlderEntries,
  prependSpaceEntries,
  spaceControls,
  spaceNewDividerIndex,
} from "@t3tools/client-runtime/spaces";
import type { EnvironmentId, SpaceId, SpaceRoomEntry } from "@t3tools/contracts";
import { Link, useParams } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  LogOutIcon,
  MoreHorizontalIcon,
  PanelRightOpenIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { openSpaceDialog } from "../../spaceDialogStore";
import { useProject, useQuietThreadProjection, useThreadShell } from "../../state/entities";
import {
  spaceEnvironment,
  useCanOperateSpaces,
  useSpaceOlderEntries,
  useSpaceRoom,
  useSpaceTasks,
  useSpaceViewer,
} from "../../state/spaces";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadVisitWatermark } from "../chat/ThreadVisitWatermark";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SpaceComposer } from "./SpaceComposer";
import { SpaceConfirmDialog } from "./SpaceConfirmDialog";
import { SpaceFeed } from "./SpaceFeed";
import { SpaceMembersPopover } from "./SpaceMembersPopover";
import { SpaceRoomPanel } from "./SpaceRoomPanel";

type Post = Extract<SpaceRoomEntry, { type: "post" }>;

export function SpaceRoomPage() {
  const params = useParams({ from: "/_chat/spaces/$environmentId/$spaceId" });
  const environmentId = params.environmentId as EnvironmentId;
  const spaceId = params.spaceId as SpaceId;
  const result = useSpaceRoom(environmentId, spaceId);
  const viewer = useSpaceViewer(environmentId);
  const contentArea = workspaceAreaProps("home", 1, "Space");

  return (
    <SidebarInset
      {...contentArea}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      {result.type === "ready" && result.room.type === "member" ? (
        <SpaceRoom
          // A different space starts with fresh drafts, quotes and New divider.
          key={`${environmentId}:${spaceId}`}
          environmentId={environmentId}
          room={result.room}
          viewer={viewer}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col bg-background">
          <WorkspacePageHeader electron={isElectron}>
            {result.type === "ready" && result.room.type === "not_member" ? (
              <h1 className="truncate font-medium text-sm">{result.room.name}</h1>
            ) : null}
          </WorkspacePageHeader>
          {result.type === "loading" ? (
            <div className="flex flex-col gap-3 p-6">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-4 w-72" />
              <Skeleton className="h-4 w-60" />
            </div>
          ) : result.type === "error" ? (
            <p className="p-6 text-muted-foreground text-sm">{result.message}</p>
          ) : result.room.type === "not_member" ? (
            <SpaceNotMember environmentId={environmentId} room={result.room} viewer={viewer} />
          ) : null}
        </div>
      )}
    </SidebarInset>
  );
}

function SpaceNotMember(props: {
  readonly environmentId: EnvironmentId;
  readonly room: Extract<ReturnType<typeof useSpaceRoom>, { type: "ready" }>["room"] & {
    type: "not_member";
  };
  readonly viewer: SpaceViewer;
}) {
  const mutate = useAtomCommand(spaceEnvironment.mutate, "Request to join");
  // Not a member: no room stream to bring the change, so ask for the page again.
  const refreshRoom = useAtomRefresh(
    spaceEnvironment.room({
      environmentId: props.environmentId,
      input: { spaceId: props.room.spaceId },
    }),
  );
  const [busy, setBusy] = useState(false);
  const owner = props.viewer.nameOf(props.room.ownerId);
  const act = async (type: "join.request" | "join.cancel") => {
    setBusy(true);
    const result = await mutate({
      environmentId: props.environmentId,
      input: { type, spaceId: props.room.spaceId },
    });
    setBusy(false);
    refreshRoom();
    toastCommandFailure(
      type === "join.request" ? "Could not ask to join" : "Could not cancel",
      result,
    );
  };
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <UsersIcon className="size-6 text-muted-foreground" />
        <h2 className="font-medium">You're not in {props.room.name}</h2>
        <p className="text-muted-foreground text-sm">
          {props.room.archived
            ? `This space is archived. Ask ${owner} if you need what's in it.`
            : props.room.requested
              ? `Request sent · ${owner} was notified.`
              : `Its ${props.room.memberCount} ${props.room.memberCount === 1 ? "member" : "members"} can see its tasks and chat.`}
        </p>
        {props.room.archived ? null : props.room.requested ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void act("join.cancel")}
          >
            Cancel request
          </Button>
        ) : (
          <Button size="sm" disabled={busy} onClick={() => void act("join.request")}>
            Ask {owner} to add you
          </Button>
        )}
        <Link to="/" className="text-muted-foreground text-sm hover:text-foreground">
          Back to Pair
        </Link>
      </div>
    </div>
  );
}

function SpaceRoom(props: {
  readonly environmentId: EnvironmentId;
  readonly room: SpaceRoomMemberState;
  readonly viewer: SpaceViewer;
}) {
  const { environmentId, room, viewer } = props;
  const space = room.space;
  const canOperate = useCanOperateSpaces(environmentId);
  const controls = spaceControls(space, viewer.memberId, canOperate);
  const tasks = useSpaceTasks(environmentId, space.id, room.tasks);
  const older = joinedSpaceOlderEntries(
    useSpaceOlderEntries(environmentId, space.id),
    room.entries,
  );
  const project = useProject(scopeProjectRef(environmentId, space.projectId));
  const roomRef = scopeThreadRef(environmentId, space.roomThreadId);
  const roomShell = useThreadShell(roomRef);
  const pairRoom = spacePairRoom(useQuietThreadProjection(roomRef)?.projection ?? null);
  const pairItems = spacePairFeedItems(pairRoom, room.actions);
  const wide = useMediaQuery("lg");
  const loadOlder = useAtomCommand(spaceEnvironment.loadOlder, "Load earlier messages");
  const mutate = useAtomCommand(spaceEnvironment.mutate, "Update space");

  // Read once: the visit tracker moves the watermark while the room is open.
  const [visitedAt] = useState(() => roomShell?.lastVisitedAt ?? null);
  const [quote, setQuote] = useState<Post | null>(null);
  const [panel, setPanel] = useState<"open" | "expanded" | "hidden" | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [confirm, setConfirm] = useState<SpaceConfirm | null>(null);
  // "Ask again" refills the composer; the count remounts it with the new draft.
  const [draft, setDraft] = useState<{ readonly n: number; readonly text: string } | null>(null);
  const panelState = panel ?? (wide ? "open" : "hidden");

  const entries = older === null ? room.entries : prependSpaceEntries(older.entries, room.entries);
  const hasOlder = older === null ? room.hasMoreEntries : older.hasMore;
  const newIndex = spaceNewDividerIndex(entries, visitedAt, viewer.memberId);

  const onLoadOlder = async () => {
    const first = entries[0];
    if (first === undefined) return;
    setLoadingOlder(true);
    await loadOlder({ environmentId, input: { spaceId: space.id, before: first.id } });
    setLoadingOlder(false);
  };
  const unarchive = async () => {
    const result = await mutate({ environmentId, input: { type: "unarchive", spaceId: space.id } });
    toastCommandFailure("Could not unarchive", result);
  };
  const pairContext = {
    environmentId,
    roomRef,
    space,
    viewer,
    pairRoom,
    tasksById: new Map(tasks.map((task) => [task.id, task])),
    onAskAgain: (text: string) => setDraft({ n: (draft?.n ?? 0) + 1, text }),
  };
  const newTask = () => openSpaceDialog({ type: "new-task", environmentId, spaceId: space.id });

  return (
    <div className="relative flex min-h-0 flex-1 bg-background">
      <ThreadVisitWatermark threadRef={roomRef} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <h1 className="truncate font-medium text-sm">{space.name}</h1>
            {project === null ? null : (
              <span className="hidden truncate text-muted-foreground text-xs sm:inline">
                {project.title}
              </span>
            )}
          </div>
          <SpaceMembersPopover
            environmentId={environmentId}
            space={space}
            viewer={viewer}
            controls={controls}
          />
          <Menu>
            <MenuTrigger
              render={<Button size="icon-sm" variant="ghost" aria-label="Space actions" />}
            >
              <MoreHorizontalIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem
                onClick={() =>
                  openSpaceDialog({ type: "settings", environmentId, spaceId: space.id })
                }
              >
                <SettingsIcon />
                Space settings
              </MenuItem>
              {controls.canLeave || controls.canArchive || controls.canUnarchive ? (
                <MenuSeparator />
              ) : null}
              {controls.canArchive ? (
                <MenuItem onClick={() => setConfirm({ type: "archive", space })}>
                  <ArchiveIcon />
                  Archive space
                </MenuItem>
              ) : null}
              {controls.canUnarchive ? (
                <MenuItem onClick={() => void unarchive()}>
                  <ArchiveRestoreIcon />
                  Unarchive
                </MenuItem>
              ) : null}
              {controls.canLeave ? (
                <MenuItem
                  variant="destructive"
                  onClick={() => setConfirm({ type: "leave", space })}
                >
                  <LogOutIcon />
                  Leave space
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
          {panelState === "hidden" ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Show panel"
              onClick={() => setPanel("open")}
            >
              <PanelRightOpenIcon />
            </Button>
          ) : null}
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1">
          <SpaceFeed
            environmentId={environmentId}
            space={space}
            entries={entries}
            pairItems={pairItems}
            pairContext={pairContext}
            viewer={viewer}
            newIndex={newIndex}
            canQuote={controls.canPost}
            hasOlder={hasOlder}
            loadingOlder={loadingOlder}
            onLoadOlder={() => void onLoadOlder()}
            onQuote={setQuote}
          />
        </div>
        {controls.archived ? (
          <div className="chat-composer-lane flex shrink-0 items-center justify-center gap-3 border-border border-t py-3 text-muted-foreground text-sm">
            <ArchiveIcon className="size-4" />
            <span>
              Archived
              {space.archivedBy === null
                ? ""
                : ` by ${space.archivedBy === viewer.memberId ? "you" : viewer.nameOf(space.archivedBy)}`}{" "}
              · read-only
            </span>
            {controls.canUnarchive ? (
              <Button size="xs" variant="outline" onClick={() => void unarchive()}>
                Unarchive
              </Button>
            ) : null}
          </div>
        ) : controls.canPost ? (
          <SpaceComposer
            key={draft?.n ?? 0}
            initialText={draft?.text}
            environmentId={environmentId}
            space={space}
            viewer={viewer}
            quote={quote}
            onQuoteChange={setQuote}
          />
        ) : null}
      </div>
      {panelState === "hidden" ? null : (
        <div className={wide ? "flex min-h-0" : "absolute inset-y-0 right-0 z-30 flex shadow-lg"}>
          <SpaceRoomPanel
            environmentId={environmentId}
            space={space}
            tasks={tasks}
            notes={room.notes}
            viewer={viewer}
            controls={controls}
            expanded={panelState === "expanded"}
            onToggleExpanded={() => setPanel(panelState === "expanded" ? "open" : "expanded")}
            onHide={() => setPanel("hidden")}
            onNewTask={newTask}
          />
        </div>
      )}
      <SpaceConfirmDialog
        environmentId={environmentId}
        viewer={viewer}
        confirm={confirm}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}
