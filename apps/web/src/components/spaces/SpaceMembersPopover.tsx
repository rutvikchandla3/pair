import {
  type SpaceConfirm,
  type SpaceControls,
  type SpaceViewer,
  orderSpaceMembers,
  spaceDefaultReassignTo,
} from "@t3tools/client-runtime/spaces";
import type { EnvironmentId, MemberId, Space } from "@t3tools/contracts";
import { CrownIcon, EllipsisIcon, LogOutIcon, UserMinusIcon, UserPlusIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { openSpaceDialog } from "../../spaceDialogStore";
import { spaceEnvironment } from "../../state/spaces";
import { useTeamMembers } from "../../state/team";
import { useAtomCommand } from "../../state/use-atom-command";
import { MemberAvatar } from "../team/MemberAvatar";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { MemberAvatarStack } from "../team/MemberAvatarStack";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";

function MemberList(props: {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly viewer: SpaceViewer;
  readonly controls: SpaceControls;
  readonly onOpenSettings: () => void;
  readonly onConfirm: (confirm: SpaceConfirm) => void;
}) {
  const { space, viewer } = props;
  const roster = useTeamMembers(props.environmentId);
  const mutate = useAtomCommand(spaceEnvironment.mutate, "Add member");
  const [busy, setBusy] = useState(false);
  const members = orderSpaceMembers(props.space);
  const row = (memberId: MemberId, trailing: ReactNode) => {
    const name = props.viewer.nameOf(memberId);
    return (
      <div key={memberId} className="flex items-center gap-2 px-1 py-1">
        <MemberAvatar
          size="sm"
          member={{ name, color: roster.get(memberId)?.color ?? "var(--muted-foreground)" }}
        />
        <span className="min-w-0 flex-1 truncate text-sm">
          {name}
          {memberId === props.viewer.memberId ? (
            <span className="text-muted-foreground"> (you)</span>
          ) : null}
        </span>
        {trailing}
      </div>
    );
  };
  const add = async (memberId: MemberId) => {
    setBusy(true);
    const result = await mutate({
      environmentId: props.environmentId,
      input: { type: "member.add", spaceId: props.space.id, memberIds: [memberId] },
    });
    setBusy(false);
    toastCommandFailure("Could not add", result);
  };
  const requests = props.controls.canManage ? props.space.joinRequests : [];
  return (
    <div className="flex flex-col gap-1">
      {members.map((member) => {
        const owner = member.memberId === space.ownerId;
        const self = member.memberId === viewer.memberId;
        const canManageRow = props.controls.canManage && !owner && !self;
        const canLeaveRow = self && props.controls.isMember && !props.controls.archived;
        return row(
          member.memberId,
          <>
            {owner ? <span className="text-muted-foreground text-xs">Owner</span> : null}
            {canManageRow || canLeaveRow ? (
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`Actions for ${viewer.nameOf(member.memberId)}`}
                    />
                  }
                >
                  <EllipsisIcon />
                </MenuTrigger>
                <MenuPopup align="end">
                  {canManageRow ? (
                    <>
                      <MenuItem
                        onClick={() =>
                          props.onConfirm({ type: "transfer", space, memberId: member.memberId })
                        }
                      >
                        <CrownIcon />
                        Make owner
                      </MenuItem>
                      <MenuItem
                        variant="destructive"
                        onClick={() =>
                          props.onConfirm({
                            type: "remove",
                            space,
                            memberId: member.memberId,
                            reassignTo: spaceDefaultReassignTo("remove", space, viewer),
                          })
                        }
                      >
                        <UserMinusIcon />
                        Remove from space
                      </MenuItem>
                    </>
                  ) : null}
                  {canLeaveRow && owner ? (
                    <MenuItem onClick={props.onOpenSettings}>
                      <CrownIcon />
                      Transfer ownership…
                    </MenuItem>
                  ) : null}
                  {canLeaveRow ? (
                    <MenuItem
                      variant="destructive"
                      disabled={!props.controls.canLeave}
                      onClick={() =>
                        props.onConfirm({
                          type: "leave",
                          space,
                          reassignTo: spaceDefaultReassignTo("leave", space, viewer),
                        })
                      }
                    >
                      <LogOutIcon />
                      <span className="flex flex-col">
                        Leave space
                        {owner ? (
                          <span className="text-muted-foreground text-xs">
                            Transfer ownership first
                          </span>
                        ) : null}
                      </span>
                    </MenuItem>
                  ) : null}
                </MenuPopup>
              </Menu>
            ) : null}
          </>,
        );
      })}
      <p className="px-1 text-muted-foreground text-xs">Only members can see this space.</p>
      {requests.length > 0 ? (
        <>
          <p className="px-1 pt-2 font-medium text-muted-foreground text-xs">Asked to join</p>
          {requests.map((request) =>
            row(
              request.memberId,
              <Button size="xs" disabled={busy} onClick={() => void add(request.memberId)}>
                Add
              </Button>,
            ),
          )}
        </>
      ) : null}
      {props.controls.canManage || props.controls.isMember ? (
        <Button size="sm" variant="ghost" onClick={props.onOpenSettings}>
          <UserPlusIcon />
          {props.controls.canManage ? "Manage members" : "Space settings"}
        </Button>
      ) : null}
    </div>
  );
}

/** The header's avatar stack; a bottom sheet on phones. */
export function SpaceMembersPopover(props: {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly viewer: SpaceViewer;
  readonly controls: SpaceControls;
  readonly onConfirm: (confirm: SpaceConfirm) => void;
}) {
  const roster = useTeamMembers(props.environmentId);
  const narrow = useMediaQuery("max-sm");
  const [open, setOpen] = useState(false);
  const members = orderSpaceMembers(props.space);
  const stack = members.map((member) => ({
    id: member.memberId,
    name: props.viewer.nameOf(member.memberId),
    color: roster.get(member.memberId)?.color ?? "var(--muted-foreground)",
    away: false,
  }));
  const label = `${members.length} ${members.length === 1 ? "member" : "members"}`;
  const pending = props.controls.canManage && props.space.joinRequests.length > 0;
  const avatars = (
    <span className="relative inline-flex">
      <MemberAvatarStack members={stack} />
      {pending ? (
        <span
          aria-hidden
          className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-input-foreground ring-2 ring-background"
        />
      ) : null}
    </span>
  );
  const triggerLabel = pending ? `${label}, someone asked to join` : label;
  const openSettings = () => {
    setOpen(false);
    openSpaceDialog({
      type: "settings",
      environmentId: props.environmentId,
      spaceId: props.space.id,
    });
  };
  const list = (
    <MemberList
      {...props}
      onOpenSettings={openSettings}
      onConfirm={(confirm) => {
        setOpen(false);
        props.onConfirm(confirm);
      }}
    />
  );
  if (narrow) {
    return (
      <>
        <Button size="sm" variant="ghost" aria-label={triggerLabel} onClick={() => setOpen(true)}>
          {avatars}
        </Button>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetPopup side="bottom">
            <div className="flex flex-col gap-2 p-4">
              <SheetTitle>{label}</SheetTitle>
              {list}
            </div>
          </SheetPopup>
        </Sheet>
      </>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button size="sm" variant="ghost" aria-label={triggerLabel} />}>
        {avatars}
      </PopoverTrigger>
      <PopoverPopup align="end" width="sm">
        <PopoverTitle>{label}</PopoverTitle>
        {list}
      </PopoverPopup>
    </Popover>
  );
}
