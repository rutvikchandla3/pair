import { useEffect } from "react";

import { registerCommands } from "../shortcuts/dispatcher";
import { isChiefOfStaffLive } from "./chiefOfStaff.logic";
import { startChiefOfStaff, stopChiefOfStaff, useChiefOfStaffStore } from "./session";
import { useChiefOfStaffTarget } from "./useChiefOfStaffTarget";

/** `chiefOfStaff.toggle`: stops a live session, else starts one where the sidebar button would. */
export function ChiefOfStaffShortcut() {
  const { environmentId, available } = useChiefOfStaffTarget();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers a handler with the app's keyboard dispatcher for the current target
  useEffect(
    () =>
      registerCommands({
        "chiefOfStaff.toggle": (event) => {
          const live = isChiefOfStaffLive(useChiefOfStaffStore.getState().phase);
          if (!live && (!available || environmentId === null)) return false;
          event.preventDefault();
          event.stopPropagation();
          if (event.repeat) return;
          if (live) stopChiefOfStaff();
          else if (environmentId !== null) startChiefOfStaff(environmentId);
        },
      }),
    [environmentId, available],
  );
  return null;
}
