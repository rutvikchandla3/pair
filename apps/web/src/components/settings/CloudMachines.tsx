import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  cloudMachineRow,
  SANDBOX_ACTION_FAILURE_TITLES,
  SANDBOX_ACTION_MENU_LABELS,
  type CloudMachineRow,
} from "@t3tools/client-runtime/state/sandbox";
import { canMemberDeleteThread } from "@t3tools/client-runtime/state/team";
import type {
  EnvironmentId,
  SandboxDriverInstance,
  SandboxOverviewMachine,
  SandboxSize,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { MoreHorizontalIcon } from "lucide-react";

import { requestConfirmDialog } from "~/confirmDialog";
import { sandboxEnvironment } from "~/state/sandbox";
import { useCurrentMemberId, useTeamMembers } from "~/state/team";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SettingsRow } from "./settingsLayout";

const SIZE_LABELS: Readonly<Record<SandboxSize, string>> = {
  small: "Small",
  default: "Default",
  large: "Large",
};

/**
 * Every live machine, for an admin: cost control does not need the threads. A machine they cannot
 * open reads "Private · <owner>", with no link, and Sleep and Discard still work on it by id.
 */
export function CloudMachines({
  environmentId,
  machines,
  drivers,
  onChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly machines: ReadonlyArray<SandboxOverviewMachine>;
  readonly drivers: ReadonlyArray<SandboxDriverInstance>;
  /** Rereads the list after Sleep or Discard. */
  readonly onChanged: () => void;
}) {
  const members = useTeamMembers(environmentId);
  const memberId = useCurrentMemberId(environmentId);
  const canOperate = useAtomValue(sandboxEnvironment.stopById.permissionAtom(environmentId));
  const stopById = useAtomCommand(sandboxEnvironment.stopById, { reportFailure: false });

  const stop = async (row: CloudMachineRow, action: "sleep" | "discard") => {
    if (action === "discard") {
      const confirmed = await requestConfirmDialog(row.discardConfirmation, {
        variant: "destructive",
      });
      if (confirmed !== true) return;
    }
    const result = await stopById({ environmentId, input: { sandboxId: row.sandboxId, action } });
    toastCommandFailure(SANDBOX_ACTION_FAILURE_TITLES[action], result);
    if (result._tag === "Success") onChanged();
  };

  return machines.map((machine) => {
    const row = cloudMachineRow(machine, {
      members,
      driverLabel:
        drivers.find((driver) => driver.id === machine.driverId)?.label ?? machine.driverId,
      sizeLabel: SIZE_LABELS[machine.size],
      age: formatRelativeTimeLabel(DateTime.formatIso(machine.createdAt)),
    });
    const allowed =
      canOperate &&
      row.actions.length > 0 &&
      canMemberDeleteThread({ members, memberId, ownerId: row.ownerId });
    return (
      <SettingsRow
        key={row.sandboxId}
        title={
          row.threadId === null ? (
            row.title
          ) : (
            <Link
              to="/$environmentId/$threadId"
              params={buildThreadRouteParams(scopeThreadRef(environmentId, row.threadId))}
              className="underline-offset-2 hover:underline"
            >
              {row.title}
            </Link>
          )
        }
        description={row.details}
        control={
          allowed ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${row.title}`} />
                }
              >
                <MoreHorizontalIcon className="size-4" />
              </MenuTrigger>
              <MenuPopup align="end">
                {row.actions.map((action) => (
                  <MenuItem
                    key={action}
                    variant={action === "discard" ? "destructive" : "default"}
                    onClick={() => void stop(row, action)}
                  >
                    {SANDBOX_ACTION_MENU_LABELS[action]}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          ) : undefined
        }
      />
    );
  });
}
